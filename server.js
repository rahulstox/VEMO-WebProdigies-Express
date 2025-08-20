const express = require("express");
const cors = require("cors");
const { Server } = require('socket.io');
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
app.use(cors())

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
      origin: '*',
      methods: ["GET", "POST"],
  },
})
// Ensure temp_upload directory exists
const uploadDir = path.join(__dirname, 'temp_upload');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Store chunks per socket connection
const socketChunks = new Map();

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
  socketChunks.set(socket.id, []);
  socket.emit("connected");

  socket.on("video-chunks", (data) => {
    try {
      console.log("🟢 Receiving video chunk for:", data.filename);
      const chunks = socketChunks.get(socket.id);
      chunks.push(data.chunks);
    } catch (error) {
      console.error("🔴 Error collecting video chunk:", error);
    }
  });

  socket.on("process-video", async (data) => {
    // ---- SECURITY IMPROVEMENT ----
    const sanitizedFilename = path.basename(data.filename); // Sirf filename use karein
    const filePath = path.join(uploadDir, sanitizedFilename);
    const chunks = socketChunks.get(socket.id);

    try {
      if (!chunks || chunks.length === 0) {
        throw new Error("No video chunks received to process.");
      }

      // ---- PERFORMANCE IMPROVEMENT (Async file write) ----
      console.log("🟢 Writing complete video file to disk...");
      const videoBlob = new Blob(chunks, { type: "video/webm; codecs=vp9" });
      const buffer = Buffer.from(await videoBlob.arrayBuffer());
      await fs.promises.writeFile(filePath, buffer); // writeFile (async)
      console.log("🟢 File written successfully:", sanitizedFilename);

      const processing = await axios.post(
        `${process.env.NEXT_API_HOST}recording/${data.userId}/processing`,
        { filename: sanitizedFilename }
      );

      if (processing.data.status !== 200) {
        throw new Error("Failed to create processing file in the main app");
      }

      const cloudinaryUpload = cloudinary.uploader.upload_stream(
        { resource_type: "video", folder: "opal", public_id: sanitizedFilename },
        async (error, result) => {
          if (error) {
            console.error("🔴 Cloudinary upload error:", error);
            socket.emit("upload-error", { message: "Video upload failed." });
            return;
          }
          try {
            console.log("🟢 Video uploaded to Cloudinary:", result.secure_url);

            if (processing.data.plan === 'PRO') {
              // ---- PERFORMANCE IMPROVEMENT (Async file stat) ----
              const fileStat = await fs.promises.stat(filePath);
              if (fileStat.size < 25 * 1024 * 1024) { // 25MB limit
                
                try {
                  console.log("🟢 Transcribing with Gemini...");
                  const transcriptionModel = genAI.getGenerativeModel({ model: "gemini-1.5-pro-latest" });
                  // ---- PERFORMANCE IMPROVEMENT (Async file read in helper) ----
                  const audioFilePart = await fileToGenerativePart(filePath, "video/webm");
                  const transcriptionPrompt = "Transcribe this audio file accurately. Provide only the text of the transcription, nothing else.";
                  const transcriptionResult = await transcriptionModel.generateContent([transcriptionPrompt, audioFilePart]);
                  const transcription = (await transcriptionResult.response).text();
                  console.log("🟢 Transcription successful.");

                  if (transcription) {
                    console.log("🟢 Generating title/summary with Gemini...");
                    const summaryModel = genAI.getGenerativeModel({ model: "gemini-pro" });
                    const summaryPrompt = `Based on the following transcription, generate a concise title and a helpful summary. Transcription: "${transcription}". Return your response in a valid JSON format like this: {"title": "Your Title", "summary": "Your Summary"}`;
                    const summaryResult = await summaryModel.generateContent(summaryPrompt);
                    const generatedContentText = (await summaryResult.response).text();

                    // ---- ROBUSTNESS IMPROVEMENT (Safely parse JSON) ----
                    let parsedContent;
                    try {
                      parsedContent = JSON.parse(generatedContentText);
                    } catch (parseError) {
                      console.error("🔴 Failed to parse Gemini JSON response:", parseError);
                      parsedContent = { title: "AI Generated Title", summary: transcription.substring(0, 200) + "..." }; // Fallback
                    }

                    console.log("🟢 Title/Summary generation successful.");

                    await axios.post(
                      `${process.env.NEXT_API_HOST}recording/${data.userId}/transcribe`,
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

            await axios.post(
              `${process.env.NEXT_API_HOST}recording/${data.userId}/complete`,
              { filename: sanitizedFilename }
            );
            
          } catch (postUploadError) {
            console.error("🔴 Error in post-upload logic:", postUploadError);
            socket.emit("upload-error", { message: "Failed to process AI features." });
          } finally {
            // Clean up temporary file
            await fs.promises.unlink(filePath);
            console.log("🟢 Deleted temp file:", sanitizedFilename);
          }
        }
      );
      fs.createReadStream(filePath).pipe(cloudinaryUpload);
    } catch (error) {
      console.error("🔴 Error in process-video event:", error.message);
      socket.emit("upload-error", { message: "An unexpected server error occurred." });
      // Agar error aaye to temp file delete karein
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
        console.log("🟢 Cleaned up temp file after error.");
      }
    } finally {
        socketChunks.set(socket.id, []);
    }
  });

  socket.on("disconnect", () => {
    console.log("🔴 Socket disconnected:", socket.id);
    socketChunks.delete(socket.id);
  });
});
// Error handling for unhandled rejections
process.on('unhandledRejection', (error) => {
  console.error('🔴 Unhandled Rejection:', error);
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