import dotenv from 'dotenv';
import express from 'express';
import axios from 'axios';

dotenv.config();
const apiKey = process.env.OPENAI_API_KEY || "";

const app = express();
const port = 3001;

app.use(express.json());

app.post('/openai', async (req, res) => {
  
    const endpoint = `https://api.openai.com/v1/chat/completions`;
    
   
    const params = {
      "model": "gpt-3.5-turbo", 
      "messages": [{"role": "user", "content": req.body.message}], 
      "temperature": 0.7 
    }
    try {
        console.log('Params:', params);
        const response = await axios.post(endpoint, params, { 
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            }
          });
      res.json(response);
    } catch (error) {
      console.error('Error in OpenAI API call:', error);
      res.status(500).send('Error in OpenAI API call');
    }
});
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});