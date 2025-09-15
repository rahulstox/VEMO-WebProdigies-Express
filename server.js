const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const fs = require("fs");
const http = require("http");
const dotenv = require("dotenv");
const { Readable } = require("stream");
const axios = require("axios");
const cloudinary = require("cloudinary").v2;
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
dotenv.config();
const app = express();
app.use(cors());

const server = http.createServer(app);

//gemini api
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// //openai
// const openai = new OpenAi({
//   apiKey: process.env.GEMINI_API_KEY,
// })

// // Set axios default headers
// axios.defaults.headers.common["origin"] = 'https://opal-express-gc8f.onrender.com';
// axios.defaults.headers.common["Content-Type"] = "application/json";

// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Socket.IO configuration with better error handling
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});
// Ensure temp_upload directory exists
const uploadDir = path.join(__dirname, "temp_upload");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Per-socket session state
// socket.id -> {
//   [filename]: {
//     filePath: string,
//     fileStream: fs.WriteStream,
//     cloudStream: NodeJS.WritableStream,
//     cloudDone: Promise<{ url: string }>,
//     cloudResolve: Function,
//     cloudReject: Function,
//     bytes: number
//   }
// }
const socketSessions = new Map();

// Helper function to convert file for Gemini (async version)
async function fileToGenerativePart(filePath, mimeType) {
  const data = await fs.promises.readFile(filePath);
  return {
    inlineData: {
      data: data.toString("base64"),
      mimeType,
    },
  };
}

io.on("connection", (socket) => {
  console.log("🟢 Socket connected:", socket.id);
  socketSessions.set(socket.id, {});
  socket.emit("connected");

  socket.on("video-chunks", (data) => {
    try {
      const { filename, chunks, seq } = data;
      const sanitizedFilename = path.basename(filename);
      const sessions = socketSessions.get(socket.id) || {};
      let session = sessions[sanitizedFilename];
      if (!session) {
        const filePath = path.join(uploadDir, sanitizedFilename);
        const fileStream = fs.createWriteStream(filePath);

        let cloudResolve;
        let cloudReject;
        const cloudDone = new Promise((res, rej) => {
          cloudResolve = res;
          cloudReject = rej;
        });
        const cloudStream = cloudinary.uploader.upload_stream(
          {
            resource_type: "video",
            folder: "opal",
            public_id: sanitizedFilename,
          },
          (error, result) => {
            if (error) return cloudReject(error);
            cloudResolve({ url: result.secure_url });
          }
        );

        session = {
          filePath,
          fileStream,
          cloudStream,
          cloudDone,
          cloudResolve,
          cloudReject,
          bytes: 0,
        };
        sessions[sanitizedFilename] = session;
        socketSessions.set(socket.id, sessions);
      }

      const buffer = Buffer.isBuffer(chunks) ? chunks : Buffer.from(chunks); // ArrayBuffer -> Buffer

      session.bytes += buffer.length;
      const okFile = session.fileStream.write(buffer);
      const okCloud = session.cloudStream.write(buffer);

      // emit progress (~bytes only; client can extrapolate)
      socket.emit("server-progress", {
        filename: sanitizedFilename,
        bytes: session.bytes,
      });

      // ACK this seq so client can send the next chunk
      socket.emit("ack", { seq });

      if (!okFile) {
        session.fileStream.once("drain", () => {});
      }
      if (!okCloud) {
        session.cloudStream.once("drain", () => {});
      }
    } catch (error) {
      console.error("🔴 Error receiving video chunk:", error);
    }
  });

  socket.on("process-video", async (data) => {
    const sanitizedFilename = path.basename(data.filename);
    const sessions = socketSessions.get(socket.id) || {};
    const session = sessions[sanitizedFilename];

    try {
      if (!session) {
        throw new Error("No active session for this filename.");
      }

      // finalize streams
      await new Promise((res) => session.fileStream.end(res));
      await new Promise((res) => session.cloudStream.end(res));
      const { url } = await session.cloudDone; // wait for Cloudinary

      const filePath = session.filePath;

      const base =
        process.env.NEXT_API_HOST?.replace(/\/$/, "") ||
        "http://localhost:3000";
      const processing = await axios.post(
        `${base}/api/recording/${data.userId}/processing`,
        { filename: sanitizedFilename }
      );

      if (processing.data.status !== 200) {
        throw new Error("Failed to create processing file in the main app");
      }

      try {
        console.log("🟢 Video uploaded to Cloudinary:", url);

        if (processing.data.plan === "PRO") {
          // ---- PERFORMANCE IMPROVEMENT (Async file stat) ----
          const fileStat = await fs.promises.stat(filePath);
          if (fileStat.size < 25 * 1024 * 1024) {
            // 25MB limit

            try {
              console.log("🟢 Transcribing with Gemini...");
              const transcriptionModel = genAI.getGenerativeModel({
                model: "gemini-1.5-pro-latest",
              });
              // ---- PERFORMANCE IMPROVEMENT (Async file read in helper) ----
              const audioFilePart = await fileToGenerativePart(
                filePath,
                "video/webm"
              );
              const transcriptionPrompt =
                "Transcribe this audio file accurately. Provide only the text of the transcription, nothing else.";
              const transcriptionResult =
                await transcriptionModel.generateContent([
                  transcriptionPrompt,
                  audioFilePart,
                ]);
              const transcription = (await transcriptionResult.response).text();
              console.log("🟢 Transcription successful.");

              if (transcription) {
                console.log("🟢 Generating title/summary with Gemini...");
                const summaryModel = genAI.getGenerativeModel({
                  model: "gemini-pro",
                });
                const summaryPrompt = `Based on the following transcription, generate a concise title and a helpful summary. Transcription: "${transcription}". Return your response in a valid JSON format like this: {"title": "Your Title", "summary": "Your Summary"}`;
                const summaryResult = await summaryModel.generateContent(
                  summaryPrompt
                );
                const generatedContentText = (
                  await summaryResult.response
                ).text();

                // ---- ROBUSTNESS IMPROVEMENT (Safely parse JSON) ----
                let parsedContent;
                try {
                  parsedContent = JSON.parse(generatedContentText);
                } catch (parseError) {
                  console.error(
                    "🔴 Failed to parse Gemini JSON response:",
                    parseError
                  );
                  parsedContent = {
                    title: "AI Generated Title",
                    summary: transcription.substring(0, 200) + "...",
                  }; // Fallback
                }

                console.log("🟢 Title/Summary generation successful.");

                await axios.post(
                  `${base}/api/recording/${data.userId}/transcribe`,
                  {
                    filename: sanitizedFilename,
                    content: JSON.stringify(parsedContent), // Ensure it's a valid JSON string
                    transcript: transcription,
                  }
                );
              }
            } catch (aiError) {
              console.error("🔴 Error during Gemini processing:", aiError);
            }
          }
        }

        await axios.post(`${base}/api/recording/${data.userId}/complete`, {
          filename: sanitizedFilename,
        });
      } catch (postUploadError) {
        console.error("🔴 Error in post-upload logic:", postUploadError);
        socket.emit("upload-error", {
          message: "Failed to process AI features.",
        });
      } finally {
        // Clean up temporary file
        try {
          await fs.promises.unlink(filePath);
        } catch {}
        console.log("🟢 Deleted temp file:", sanitizedFilename);
        // clear session
        delete sessions[sanitizedFilename];
      }
    } catch (error) {
      console.error("🔴 Error in process-video event:", error.message);
      socket.emit("upload-error", {
        message: "An unexpected server error occurred.",
      });
      const filePath = session?.filePath;
      if (filePath && fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
        console.log("🟢 Cleaned up temp file after error.");
      }
    } finally {
      socketSessions.set(socket.id, sessions);
    }
  });

  socket.on("disconnect", () => {
    console.log("🔴 Socket disconnected:", socket.id);
    const sessions = socketSessions.get(socket.id) || {};
    Object.values(sessions).forEach((s) => {
      try {
        s.fileStream?.destroy();
      } catch {}
      try {
        s.cloudStream?.destroy();
      } catch {}
      if (s.filePath && fs.existsSync(s.filePath)) {
        try {
          fs.unlinkSync(s.filePath);
        } catch {}
      }
    });
    socketSessions.delete(socket.id);
  });
});
// Error handling for unhandled rejections
process.on("unhandledRejection", (error) => {
  console.error("🔴 Unhandled Rejection:", error);
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, async () => {
  console.log(`🟢 Server listening on port ${PORT}`);
});

// fix: Prevent video file corruption from chunk overwriting

// The previous implementation created a new write stream for every
// incoming video chunk, which caused the file to be overwritten
// repeatedly, saving only the final chunk.

// This change modifies the logic to:
// - Collect all chunks in memory first.
// - Write the complete file to disk only once in the 'process-video' event.
