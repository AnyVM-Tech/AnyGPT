const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
const port = 3000;

app.use(bodyParser.json());

app.post("/v1/engines/:engine_id/completions", (req, res) => {
    if (!req.body.message) {
        return res
            .status(400)
            .json({ error: "Missing message in request body" });
    }

    axios
        .post("http://localhost:3001/gemini", { message: req.body.message })
        .then((response) => {
            res.json(response.data);
        })
        .catch((error) => {
            res.status(500).json({ error: error.message });
        });
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
