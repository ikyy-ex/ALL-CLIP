
const $ = id => document.getElementById(id);

let videoId = null;
let videoDuration = 0;
let segments = [];
let aiData = null;

const toast = message => {
  $("toast").textContent = message;
  $("toast").style.display = "block";
  setTimeout(() => $("toast").style.display = "none", 3500);
};

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Terjadi kesalahan.");
  }

  return data;
}

function showResult(value) {
  $("aiResult").textContent =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function setBusy(button, busy, text) {
  button.disabled = busy;
  button.textContent = busy ? "Sedang memproses..." : text;
}

async function uploadVideo(file) {
  if (!file) return;

  if (!file.type.startsWith("video/")) {
    return toast("File harus berupa video.");
  }

  const form = new FormData();
  form.append("video", file);

  toast("Mengunggah video...");

  try {
    const data = await api("/api/upload", {
      method: "POST",
      body: form
    });

    videoId = data.id;
    videoDuration = data.duration;

    const preview = $("preview");
    preview.src = URL.createObjectURL(file);
    preview.style.display = "block";
    $("dropArea").style.display = "none";

    $("videoStatus").textContent = "Video siap diedit";
    $("duration").textContent =
      "Durasi: " + videoDuration.toFixed(1) + " detik";

    $("endTime").value = Math.max(1, Math.floor(videoDuration));
    toast("Video berhasil diunggah.");
  } catch (error) {
    toast(error.message);
  }
}

$("videoInput").addEventListener("change", e => {
  uploadVideo(e.target.files[0]);
});

$("dropArea").addEventListener("dragover", e => e.preventDefault());

$("dropArea").addEventListener("drop", e => {
  e.preventDefault();
  uploadVideo(e.dataTransfer.files[0]);
});

$("newProject").addEventListener("click", () => {
  location.reload();
});

function renderSegments() {
  const area = $("segments");
  area.innerHTML = "";

  if (!segments.length) {
    area.innerHTML = '<p class="empty">Belum ada segmen.</p>';
    return;
  }

  segments.forEach((s, index) => {
    const item = document.createElement("div");
    item.className = "segment";

    const label = document.createElement("span");
    label.textContent =
      `Segmen ${index + 1}: ${s.start}s – ${s.end}s`;

    const remove = document.createElement("button");
    remove.textContent = "Hapus";
    remove.addEventListener("click", () => {
      segments.splice(index, 1);
      renderSegments();
    });

    item.append(label, remove);
    area.appendChild(item);
  });
}

$("addSegment").addEventListener("click", () => {
  if (!videoId) return toast("Upload video terlebih dahulu.");

  const start = Number($("startTime").value);
  const end = Number($("endTime").value);

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    end > videoDuration
  ) {
    return toast("Periksa waktu mulai dan selesai.");
  }

  segments.push({ start, end });
  renderSegments();
});

async function analyze(mode = "analyze") {
  if (!videoId) return toast("Upload video terlebih dahulu.");

  if (mode === "subtitle") return makeSubtitle();
  if (mode === "voice") {
    $("voiceText").focus();
    return toast("Masukkan teks narasi pada bagian AI Voice.");
  }

  const button = $("analyzeBtn");
  setBusy(button, true, "✧ Jalankan AI Auto Edit");

  try {
    const data = await api("/api/ai/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: videoId,
        description: $("description").value
      })
    });

    aiData = data.result;

    if (mode === "highlight") {
      showResult(aiData.highlights || []);
    } else if (mode === "music") {
      showResult(aiData.music || {});
    } else {
      showResult(aiData);
    }

    // Gunakan rekomendasi cut sebagai segmen awal editor.
    if (mode === "analyze" && aiData.cuts?.length) {
      segments = aiData.cuts.map(s => ({
        start: Number(s.start),
        end: Number(s.end)
      })).filter(s =>
        s.start >= 0 &&
        s.end > s.start &&
        s.end <= videoDuration
      );

      renderSegments();
    }

    toast("Analisis AI selesai.");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(button, false, "✧ Jalankan AI Auto Edit");
  }
}

$("analyzeBtn").addEventListener("click", () => analyze("analyze"));

async function makeSubtitle() {
  try {
    showResult("AI sedang membuat transkrip...");
    const data = await api("/api/ai/subtitle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: videoId })
    });

    showResult(data.text + "\n\n" + data.note);
    toast("Transkrip selesai.");
  } catch (error) {
    toast(error.message);
  }
}

$("voiceBtn").addEventListener("click", async () => {
  const text = $("voiceText").value.trim();
  if (!text) return toast("Masukkan teks narasi.");

  try {
    setBusy($("voiceBtn"), true, "Buat Suara AI");

    const data = await api("/api/ai/voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });

    $("voiceAudio").src = data.url;
    toast("Suara AI selesai dibuat.");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy($("voiceBtn"), false, "Buat Suara AI");
  }
});

async function exportVideo() {
  if (!videoId) return toast("Upload video terlebih dahulu.");
  if (!segments.length) return toast("Tambahkan segmen terlebih dahulu.");

  try {
    setBusy($("renderBtn"), true, "Render Video ✦");
    setBusy($("exportBtn"), true, "Rendering...");

    const data = await api("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: videoId,
        segments,
        quality: $("quality").value
      })
    });

    const link = document.createElement("a");
    link.href = data.url;
    link.download = "all-clip-export.mp4";
    link.textContent = "Unduh hasil video";
    link.style.display = "block";
    link.style.marginTop = "15px";
    $("aiResult").appendChild(link);

    toast("Export berhasil.");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy($("renderBtn"), false, "Render Video ✦");
    setBusy($("exportBtn"), false, "Export Video ↗");
  }
}

$("renderBtn").addEventListener("click", exportVideo);
$("exportBtn").addEventListener("click", exportVideo);

document.querySelectorAll("[data-tool]").forEach(button => {
  button.addEventListener("click", () => {
    analyze(button.dataset.tool);
  });
});

renderSegments();
