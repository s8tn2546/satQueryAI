import express from 'express';
import ToolRegistry from '../models/ToolRegistry.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const tools = await ToolRegistry.find();
    return res.status(200).json(tools);
  } catch (error) {
    return res.status(500).json({ status: 'failed', error: error.message });
  }
});

export default router;
