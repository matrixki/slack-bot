require("dotenv").config();
const { App, ExpressReceiver } = require("@slack/bolt");
const axios = require("axios");
const http = require("http"); 

const fs = require("fs");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const csvParser = require("csv-parser");

// ✅ Ensure `uploads/` directory exists
if (!fs.existsSync("./uploads")) {
    fs.mkdirSync("./uploads");
}

// ✅ Configure Multer for File Uploads
const upload = multer({ dest: "uploads/" });

const db = require("./db");
const { OpenAI } = require("openai");
const { pineconeIndex } = require("./pinecone");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const { WebClient } = require("@slack/web-api");
const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

const receiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET
});

// ✅ Initialize Slack Bot
const slackApp = new App({
    token: process.env.SLACK_BOT_TOKEN,
    receiver // ✅ Attach ExpressReceiver
});

// ✅ Store Slack Messages in MySQL
async function storeSlackMessage(message) {
    try {
        await db.query(
            `INSERT INTO messages (slack_message_id, channel, user_id, text) 
            VALUES (?, ?, ?, ?) 
            ON DUPLICATE KEY UPDATE text = VALUES(text)`,
            [message.ts, message.channel, message.user, message.text]
        );
        console.log("✅ Message stored in MySQL.");
    } catch (error) {
        console.error("❌ MySQL Storage Error:", error);
    }
}

// ✅ Store AI Queries in MySQL
async function storeQuery(userId, userMessage, botResponse) {
    try {
        await db.query(
            "INSERT INTO queries (user_id, user_message, bot_response, source) VALUES (?, ?, ?, ?)", 
            [userId, userMessage, botResponse, "slack"]
        );
        console.log("✅ Query logged in MySQL.");
    } catch (error) {
        console.error("❌ MySQL Storage Error:", error);
    }
}

// ✅ Get OpenAI Embeddings
async function getEmbedding(text) {
    try {
        const response = await openai.embeddings.create({
            model: "text-embedding-ada-002",
            input: text
        });
        return response.data[0].embedding;
    } catch (error) {
        console.error("❌ Embedding Error:", error);
        return null;
    }
}

// ✅ Store Message in Pinecone
async function storeMessageInPinecone(channel, text, messageId) {
    const vector = await getEmbedding(text);
    if (!vector) return;

    try {
        await pineconeIndex.upsert([
            {
                id: messageId,
                values: vector,
                metadata: { channel, text }
            }
        ]);
        console.log(`✅ Stored message in Pinecone: ${text}`);
    } catch (error) {
        console.error("❌ Pinecone Storage Error:", error);
    }
}

// ✅ Retrieve Similar Messages from Pinecone
async function retrieveSimilarMessages(query) {
    const queryVector = await getEmbedding(query);
    if (!queryVector) return [];

    try {
        const results = await pineconeIndex.query({
            vector: queryVector,
            topK: 5,
            includeMetadata: true
        });

        return results.matches.map(match => ({
            text: match.metadata.text,
            channel: match.metadata.channel,
            thread_ts: match.metadata.thread_ts || null
        }));
    } catch (error) {
        console.error("❌ Pinecone Retrieval Error:", error);
        return [];
    }
}

// ✅ Retrieve Thread Messages from Slack
async function retrieveThreadMessages(channel, thread_ts) {
    if (!thread_ts) return [];

    try {
        const response = await slackClient.conversations.replies({
            channel: channel,
            ts: thread_ts,
            limit: 5
        });

        return response.messages
            .filter(msg => !msg.subtype)
            .map(msg => msg.text)
            .reverse();
    } catch (error) {
        console.error("❌ Slack Thread Retrieval Error:", error);
        return [];
    }
}

// ✅ Get AI Response from OpenAI
async function getOpenAIResponse(userMessage, userId, similarMessages = [], fileContext = "") {
    const messages = [
        { role: "system", content: "You are a helpful Slack assistant." },
        ...similarMessages.map(msg => ({ role: "user", content: msg })),
        { role: "user", content: userMessage }
    ];

    if (fileContext) {
        messages.push({ role: "user", content: `Relevant File Data: ${fileContext}` });
    }

    try {
        const response = await axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
                model: "gpt-4o",
                messages: messages,
                temperature: 0.7
            },
            {
                headers: {
                    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
                    "Content-Type": "application/json"
                }
            }
        );

        const botResponse = response.data.choices[0].message.content;
        await storeQuery(userId, userMessage, botResponse);

        return botResponse;
    } catch (error) {
        console.error("❌ OpenAI API Error:", error.response ? error.response.data : error.message);
        return "I'm sorry, but I couldn't process your request.";
    }
}

// ✅ Extract Text from CSV
async function extractCSVText(filePath) {
    return new Promise((resolve, reject) => {
        let text = "";
        fs.createReadStream(filePath)
            .pipe(csvParser())
            .on("data", (row) => {
                text += Object.values(row).join(" ") + "\n"; // Convert CSV row to text
            })
            .on("end", () => resolve(text))
            .on("error", (error) => reject(error));
    });
}

// ✅ Fetch Bot User ID
let botUserId = null;
async function fetchBotUserId() {
    try {
        if (process.env.NODE_ENV === "test") return;
        const authResponse = await slackClient.auth.test();
        botUserId = authResponse.user_id;
        console.log(`🤖 Bot User ID: ${botUserId}`);
    } catch (error) {
        console.error("❌ Error fetching bot user ID:", error);
    }
}
fetchBotUserId(); // Fetch bot ID on startup

// ✅ Handle Messages in Slack
slackApp.message(async ({ event, message, say }) => {
    console.log("📥 Incoming message:", message);
    if (!message.text) return;
    if (message.subtype === "bot_message") return;

    console.log(`📩 New message in #${event.channel}: ${event.text}`);

    // ✅ Store Message in MySQL
    await storeSlackMessage(message);

    // ✅ Store Message in Pinecone
    await storeMessageInPinecone(message.channel, message.text, message.ts);

    const botMentioned = botUserId && message.text.includes(`<@${botUserId}>`);
    console.log("📌 Bot Mentioned:", botMentioned);

    if (event.channel_type === "im" || botMentioned) {
        console.log(`💬 DM from user ${event.user}: ${event.text}`);

        // ✅ Retrieve Past Messages
        let pastMessages = [];
        if (message.thread_ts) {
            pastMessages = await retrieveThreadMessages(message.channel, message.thread_ts);
            console.log("🔄 Thread Messages:", pastMessages);
        }

        // ✅ Retrieve Similar Messages if No Thread
        if (pastMessages.length === 0) {
            const similarMessages = await retrieveSimilarMessages(message.text);
            console.log("🔍 Similar Messages:", similarMessages);

            for (let msg of similarMessages) {
                if (msg.thread_ts) {
                    const threadMessages = await retrieveThreadMessages(msg.channel, msg.thread_ts);
                    pastMessages = [...pastMessages, ...threadMessages];
                } else {
                    pastMessages.push(msg.text);
                }
            }
        }

        // ✅ Retrieve File Context from Uploaded Files
        const [rows] = await db.query(
            "SELECT file_content FROM uploaded_files WHERE user_id = ? ORDER BY uploaded_at DESC",
            [message.user]
        );
        console.log("📂 Extracted File Content for AI:", rows);
        
        let fileContext = "";

        if (Array.isArray(rows) && rows.length > 0) {
            fileContext = rows.map(file => file.file_content).join("\n");
        } else if (rows?.file_content) {
            // Handle case where `rows` is a single object instead of an array
            fileContext = rows.file_content;
        }
        console.log("📂 File Context for AI:", fileContext);

        // ✅ Get AI Response
        const response = await getOpenAIResponse(message.text, message.user, pastMessages, fileContext);

        await say({
            text: response,
            ...(message.thread_ts ? { thread_ts: message.thread_ts } : {}) // ✅ Reply in thread only if it's a thread
        });
    }
});

// ✅ Listen for file upload events
slackApp.event("file_shared", async ({ event, client }) => {
    try {
        console.log(`📂 File Upload Event Detected:`, event);

        // ✅ Get File Info from Slack
        const fileInfo = await client.files.info({ file: event.file_id });

        if (!fileInfo || !fileInfo.file) {
            console.log("❌ Failed to retrieve file info.");
            return;
        }

        const fileName = fileInfo.file.name || `file_${event.file_id}`;
        const fileUrl = fileInfo.file.url_private_download;
        const fileType = fileInfo.file.mimetype;
        const userId = fileInfo.file.user;

        console.log(`📂 File Uploaded: ${fileName}`);

        // ✅ Ensure file path is correct
        const filePath = `uploads/${fileName}`;

        // ✅ Download the File
        const fileData = await axios({
            url: fileUrl,
            method: "GET",
            headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
            responseType: "stream",
        });

        const writer = fs.createWriteStream(filePath);
        fileData.data.pipe(writer);

        writer.on("finish", async () => {
            let extractedText = "";

            // ✅ Extract Text Based on File Type
            if (fileType === "application/pdf") {
                const dataBuffer = fs.readFileSync(filePath);
                const pdfData = await pdfParse(dataBuffer);
                extractedText = pdfData.text;
            } else if (fileType === "text/plain") {
                extractedText = fs.readFileSync(filePath, "utf8");
            } else if (fileType === "text/csv") {
                extractedText = await extractCSVText(filePath);
            } else {
                console.log("❌ Unsupported file type.");
                return;
            }

            // ✅ Store Extracted Text in DB
            await db.query(
                "INSERT INTO uploaded_files (user_id, file_name, file_type, file_content) VALUES (?, ?, ?, ?)",
                [userId, fileName, fileType, extractedText]
            );

            console.log(`📄 Text extracted from file: ${extractedText}`);
            // ✅ Remove File After Processing
            fs.unlinkSync(filePath);

            console.log(`✅ File processed and stored for user ${userId}.`);
        });
    } catch (error) {
        console.error("❌ Error processing file:", error);
    }
});

// ✅ API Route for Dashboard Users to Chat with the Bot
receiver.router.use(require("express").json());
receiver.router.post("/api/chat", async (req, res) => {
    try {
        const { userId, message } = req.body;

        if (!userId || !message) {
            return res.status(400).json({ error: "User ID and message are required." });
        }

        console.log(`📩 API Message from User ${userId}: ${message}`);

        let pastMessages = [];
        // ✅ Retrieve Similar Messages if No Thread
        if (pastMessages.length === 0) {
            const similarMessages = await retrieveSimilarMessages(message);
            console.log("🔍 Similar Messages:", similarMessages);

            for (let msg of similarMessages) {
                if (msg.thread_ts) {
                    const threadMessages = await retrieveThreadMessages(msg.channel, msg.thread_ts);
                    pastMessages = [...pastMessages, ...threadMessages];
                } else {
                    pastMessages.push(msg.text);
                }
            }
        }

        // ✅ Retrieve File Context from Uploaded Files
        const rows = await db.query(
            "SELECT file_content FROM uploaded_files WHERE user_id = ? ORDER BY uploaded_at DESC",
            [userId]
        );

        console.log("📂 Extracted File Content for AI:", rows);

        let fileContext = "";

        if (Array.isArray(rows) && rows.length > 0) {
            fileContext = rows.map(file => file.file_content).join("\n");
        } else if (rows?.file_content) {
            fileContext = rows.file_content;
        }

        console.log("📂 Extracted File Context for AI:", fileContext);

        // ✅ Get AI response
        const botResponse = await getOpenAIResponse(message, userId, pastMessages, fileContext);
        console.log(`🤖 Bot Response to User ${userId}: ${botResponse}`);

        // ✅ Store User Message and Bot Response in DB with source = 'dashboard'
        await db.query(
            "INSERT INTO queries (user_id, user_message, bot_response, source) VALUES (?, ?, ?, 'dashboard')",
            [userId, message, botResponse]
        );

        // ✅ Send JSON response
        return res.json({ response: botResponse });
    } catch (error) {
        console.error("❌ API Error:", error);
        return res.status(500).json({ error: "Failed to process message." });
    }
});
receiver.router.get("/api/conversations", async (req, res) => {
    try {
        const { userId } = req.query;

        if (!userId) {
            return res.status(400).json({ error: "User ID is required." });
        }

        console.log(`📜 Fetching conversations for User ${userId}`);

        // ✅ Retrieve conversations for both Slack & Dashboard messages
        const result = await db.query(
            "SELECT user_message, bot_response, source, timestamp FROM queries WHERE user_id = ? ORDER BY timestamp ASC",
            [userId]
          );

        console.log("📜 Conversations fetched:", result);

        // ✅ Ensure the result is an array
        const conversations = Array.isArray(result) ? result : [];
        
        return res.json({ conversations });
    } catch (error) {
        console.error("❌ API Error:", error);
        return res.status(500).json({ error: "Failed to fetch conversations." });
    }
});
// ✅ File Upload Endpoint
receiver.router.post("/api/upload", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No file uploaded." });
        }

        const { userId } = req.body;
        const filePath = req.file.path;
        const fileType = req.file.mimetype;
        let extractedText = "";

        console.log(`📂 Processing file upload: ${req.file.originalname}`);

        // ✅ Extract Text Based on File Type
        if (fileType === "application/pdf") {
            const dataBuffer = fs.readFileSync(filePath);
            const pdfData = await pdfParse(dataBuffer);
            extractedText = pdfData.text;
        } else if (fileType === "text/plain") {
            extractedText = fs.readFileSync(filePath, "utf8");
        } else if (fileType === "text/csv") {
            extractedText = await extractCSVText(filePath);
        } else {
            return res.status(400).json({ error: "Unsupported file type." });
        }

        // ✅ Save Extracted Content in DB
        await db.query(
            "INSERT INTO uploaded_files (user_id, file_name, file_type, file_content) VALUES (?, ?, ?, ?)",
            [userId, req.file.originalname, fileType, extractedText]
        );

        // ✅ Remove File After Processing
        fs.unlinkSync(filePath);

        return res.json({ message: "File uploaded successfully!", extractedText });
    } catch (error) {
        console.error("❌ File Upload Error:", error);
        return res.status(500).json({ error: "Failed to process file." });
    }
});


// ✅ Start Slack Bot
if (process.env.NODE_ENV !== "test") {
    (async () => {
        const port = process.env.PORT || 3000;
        await slackApp.start(port);
        console.log(`🚀 Slack Bot & API are running on port ${port}`);
    })();
}

module.exports = { slackApp, receiver };
