
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import OpenAI from "openai";
import { v4 as uuid } from "uuid";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

dotenv.config();

const app = express();
const exec = promisify(execFile);
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const ROOT = process.cwd();
const UPLOADS = path.join(ROOT, "uploads");
const OUTPUTS = path.join(ROOT, "outputs");

fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(OUTPUTS, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));
app.use("/outputs", express.static(OUTPUTS));

const storage = multer.diskStorage({
  destination: UPLOADS,
  filename: (req, file, cb) => {
    cb(null, uuid() + path.extname(file.originalname).toLowerCase());
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_MB || 500) * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("video/")) cb(null, true);
    else cb(new Error("File harus berupa video."));
  }
});

function getVideoPath(id) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) {
    throw new Error("ID video tidak valid.");
  }

  const file = fs.readdirSync(UPLOADS)
    .find(name => name.startsWith(id));

  if (!file) throw new Error("Video tidak ditemukan.");
  return path.join(UPLOADS, file);
}

async function videoInfo(file) {
  const { stdout } = await exec("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    file
  ]);

  return JSON.parse(stdout);
}

app.get("/api/health", (req, res) => {
  res.json({ status: "online", app: "ALL-CLIP AI STUDIO" });
});

// Upload video
app.post("/api/upload", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Pilih video terlebih dahulu." });
    }

    const id = path.basename(req.file.filename).split(".")[0];
    const info = await videoInfo(req.file.path);

    res.json({
      id,
      filename: req.file.originalname,
      size: req.file.size,
      duration: Number(info.format.duration || 0),
      url: `/uploads/${req.file.filename}`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// AI analysis: editing plan, highlights, transitions and music suggestions
app.post("/api/ai/analyze", async (req, res) => {
  try {
    const { id, description = "" } = req.body;
    const file = getVideoPath(id);
    const info = await videoInfo(file);

    const duration = Number(info.format.duration || 0);
    const streams = info.streams || [];
    const video = streams.find(s => s.codec_type === "video");

    const prompt = `
Kamu adalah asisten editor video profesional.
Buat rencana editing berdasarkan metadata berikut.

Durasi: ${duration} detik
Resolusi sumber: ${video?.width || 0}x${video?.height || 0}
Deskripsi pengguna: ${description}

Kembalikan JSON dengan struktur:
{
 "summary": "ringkasan video",
 "editing_style": "gaya editing",
 "highlights": [
   {"start": 0, "end": 10, "reason": "alasan"}
 ],
 "cuts": [
   {"start": 0, "end": 10, "label": "nama segmen"}
 ],
 "transitions": ["rekomendasi transisi"],
 "music": {
   "mood": "suasana",
   "bpm": "perkiraan BPM",
   "suggestion": "jenis musik"
 },
 "captions_tip": "saran subtitle"
}

Gunakan angka detik. Jangan membuat waktu melebihi durasi video.
`;

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt
    });

    const raw = response.output_text;
    const cleaned = raw.replace(/```json|```/g, "").trim();

    res.json({
      result: JSON.parse(cleaned),
      duration
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Smart Cut / AI Clip Generator
app.post("/api/export", async (req, res) => {
  try {
    const { id, segments, quality = "1080p" } = req.body;
    const input = getVideoPath(id);

    if (!Array.isArray(segments) || segments.length === 0) {
      return res.status(400).json({ error: "Tambahkan segmen video." });
    }

    const allowed = ["1080p", "720p"];
    if (!allowed.includes(quality)) {
      return res.status(400).json({ error: "Kualitas tidak valid." });
    }

    const info = await videoInfo(input);
    const duration = Number(info.format.duration || 0);

    const validSegments = segments.map(s => ({
      start: Number(s.start),
      end: Number(s.end)
    }));

    for (const s of validSegments) {
      if (
        !Number.isFinite(s.start) ||
        !Number.isFinite(s.end) ||
        s.start < 0 ||
        s.end <= s.start ||
        s.end > duration
      ) {
        return res.status(400).json({ error: "Waktu segmen tidak valid." });
      }
    }

    const outputId = uuid();
    const output = path.join(OUTPUTS, outputId + ".mp4");
    const parts = [];

    for (let i = 0; i < validSegments.length; i++) {
      const s = validSegments[i];
      const part = path.join(OUTPUTS, `${outputId}-${i}.mp4`);

      const height = quality === "1080p" ? "1080" : "720";

      await exec("ffmpeg", [
        "-y",
        "-ss", String(s.start),
        "-i", input,
        "-t", String(s.end - s.start),
        "-vf",
        `scale=-2:${height}:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2`,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-c:a", "aac",
        "-movflags", "+faststart",
        part
      ]);

      parts.push(part);
    }

    const list = path.join(OUTPUTS, `${outputId}.txt`);

    fs.writeFileSync(
      list,
      parts.map(p => `file '${p.replace(/\\/g, "/")}'`).join("\n")
    );

    await exec("ffmpeg", [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", list,
      "-c", "copy",
      "-movflags", "+faststart",
      output
    ]);

    parts.forEach(p => fs.unlinkSync(p));
    fs.unlinkSync(list);

    res.json({
      message: "Export berhasil.",
      url: `/outputs/${outputId}.mp4`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Auto Subtitle: transcribe audio from video
app.post("/api/ai/subtitle", async (req, res) => {
  const temp = path.join(OUTPUTS, uuid() + ".mp3");

  try {
    const { id } = req.body;
    const input = getVideoPath(id);

    await exec("ffmpeg", [
      "-y", "-i", input,
      "-vn", "-ac", "1",
      "-b:a", "64k",
      "-t", "600",
      temp
    ]);

    if (fs.statSync(temp).size > 24 * 1024 * 1024) {
      throw new Error("Audio terlalu besar untuk satu permintaan subtitle.");
    }

    const transcript = await openai.audio.transcriptions.create({
      file: fs.createReadStream(temp),
      model: "gpt-transcribe"
    });

    res.json({
      text: transcript.text,
      note: "Teks transkrip tersedia. Waktu subtitle perlu disesuaikan."
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
});

// AI Voice
app.post("/api/ai/voice", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || text.length > 4000) {
      return res.status(400).json({ error: "Teks kosong atau terlalu panjang." });
    }

    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: text
    });

    const id = uuid();
    const output = path.join(OUTPUTS, id + ".mp3");

    fs.writeFileSync(output, Buffer.from(await speech.arrayBuffer()));

    res.json({ url: `/outputs/${id}.mp3` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.use((error, req, res, next) => {
  res.status(400).json({ error: error.message });
});

app.listen(PORT, () => {
  console.log(`ALL-CLIP AI STUDIO berjalan di http://localhost:${PORT}`);
});
