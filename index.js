const express = require("express");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const config = require("./config");

const app = express();
app.use(express.json());



// Baca semua port dari nginx map, return port terakhir + 1
function getNextPort() {
    if (!fs.existsSync(config.NGINX_CONF)) return config.START_PORT;
    const content = fs.readFileSync(config.NGINX_CONF, "utf8");
    const ports = [...content.matchAll(/^\S+\s+(\d+);/gm)]
        .map(m => parseInt(m[1], 10))
        .filter(n => !isNaN(n));
    if (ports.length === 0) return config.START_PORT;
    return Math.max(...ports) + 1;
}

function validSessionId(id) {
    return /^[a-z0-9_-]+$/.test(id);
}

// Helper: cek apakah service sudah ada di docker-compose
function serviceExists(sessionId) {
    if (!fs.existsSync(config.COMPOSE_FILE)) return false;
    const content = fs.readFileSync(config.COMPOSE_FILE, "utf8");
    return content.includes(`waha-${sessionId}:`);
}

app.post("/sessions", (req, res) => {
    const { sessionId } = req.body;

    if (!sessionId || !validSessionId(sessionId)) {
        return res.status(400).json({ error: "Invalid sessionId" });
    }

    const sessionDir = path.join(config.SESSIONS_DIR, sessionId);
    if (fs.existsSync(sessionDir) || serviceExists(sessionId)) {
        return res.status(409).json({ error: "Session already exists" });
    }

    const port = getNextPort();

    try {
        // 1. Buat folder session
        fs.mkdirSync(sessionDir, { recursive: true });

        // 2. Append docker-compose service
        // Baca file dulu
        // baca file
        let composeFile = fs.readFileSync(config.COMPOSE_FILE, "utf8");

        // pecah per baris
        let lines = composeFile.split("\n");

        // cari index 'services:'
        let insertIndex = lines.findIndex(line => line.trim() === "services:");
        if (insertIndex === -1) throw new Error("docker-compose.yml tidak memiliki blok 'services:'");
        insertIndex++; // insert setelah 'services:'

        // service block dengan indentasi 2 spasi
        let serviceBlock = fs.readFileSync(path.join(__dirname, "docker-compose.yml.example"), "utf8");
        serviceBlock = serviceBlock.replaceAll("{port}", port);
        serviceBlock = serviceBlock.replaceAll("{session}", sessionId);

        // masukkan service
        lines.splice(insertIndex, 0, serviceBlock);

        // simpan kembali
        fs.writeFileSync(config.COMPOSE_FILE, lines.join("\n"));

        // 3️⃣ Update nginx map
        const nginxAppend = `${sessionId} ${port};\n`;
        fs.appendFileSync(config.NGINX_CONF, nginxAppend);

        // 4️⃣ Pull image dulu kalau belum ada
        execSync(`docker image inspect devlikeapro/waha:gows || docker pull devlikeapro/waha:gows`, { stdio: "inherit" });

        // 5️⃣ Jalankan container
        execSync(`docker compose up -d waha-${sessionId}`, { stdio: "inherit", cwd: config.WAHA_ROOT });

        // 6️⃣ Reload nginx (sudo diperlukan jika tidak berjalan sebagai root)
        execSync(`sudo nginx -t && sudo nginx -s reload`, { stdio: "inherit" });

        res.json({ success: true, sessionId, port });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to create session", details: err.message });
    }
});

app.listen(4000, () => {
    console.log("Session Manager running on 127.0.0.1:4000");
});