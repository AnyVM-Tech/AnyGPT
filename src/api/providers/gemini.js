const dotenv = require("dotenv");
const express = require("express");

const {
    GoogleGenerativeAI,
    HarmCategory,
    HarmBlockThreshold,
} = require("@google/generative-ai");
dotenv.config();
const apiKey = process.env.GEMINI_API_KEY || "";

const app = express();
const port = 3001;

app.use(express.json());

const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({
    model: "gemini-1.0-pro",
});

const generationConfig = {
    temperature: 1,
    topP: 0.95,
    topK: 64,
    maxOutputTokens: 8192,
    responseMimeType: "text/plain",
};

const safetySettings = [
    {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
    },
];

app.post("/gemini", async (req, res) => {
    try {
        const chatSession = model.startChat({
            generationConfig,
            safetySettings,
            history: [],
        });
        const result = await chatSession.sendMessage(req.body.message);
        const responseText = await result.response.text();
        console.log("Result:", responseText);
        res.json({ message: responseText });
    } catch (error) {
        console.error("Error in Gemini API call:", error);
        res.status(500).send("Error in Gemini API call");
    }
});

const path = require("path");

// For dev only, remove in prod
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "../../webui/index.html"));
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
