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

// GET /sessions — list semua session dari nginx map
app.get("/sessions", (req, res) => {
    if (!fs.existsSync(config.NGINX_CONF)) {
        return res.json([]);
    }
    const content = fs.readFileSync(config.NGINX_CONF, "utf8");
    const sessions = [...content.matchAll(/^(\S+)\s+(\d+);/gm)].map(m => ({
        sessionId: m[1],
        port: parseInt(m[2], 10),
    }));
    res.json(sessions);
});

// DELETE /sessions/:sessionId — hentikan container, hapus semua config & data
app.delete("/sessions/:sessionId", (req, res) => {
    const { sessionId } = req.params;

    if (!validSessionId(sessionId)) {
        return res.status(400).json({ error: "Invalid sessionId" });
    }

    const sessionDir = path.join(config.SESSIONS_DIR, sessionId);
    if (!fs.existsSync(sessionDir) && !serviceExists(sessionId)) {
        return res.status(404).json({ error: "Session not found" });
    }

    try {
        // 1️⃣ Stop & remove container
        execSync(`docker compose stop waha-${sessionId} && docker compose rm -f waha-${sessionId}`, {
            stdio: "inherit",
            cwd: config.WAHA_ROOT,
        });

        // 2️⃣ Hapus service block dari docker-compose.yml
        if (fs.existsSync(config.COMPOSE_FILE)) {
            let compose = fs.readFileSync(config.COMPOSE_FILE, "utf8");
            // Hapus blok mulai dari "  waha-<id>:" sampai sebelum service berikutnya atau akhir services
            const svcRegex = new RegExp(
                `(  waha-${sessionId}:[\\s\\S]*?)(?=\\n  \\S|\\nnetworks:|\\nvolumes:|$)`,
                "m"
            );
            compose = compose.replace(svcRegex, "");
            fs.writeFileSync(config.COMPOSE_FILE, compose);
        }

        // 3️⃣ Hapus entry dari nginx map
        if (fs.existsSync(config.NGINX_CONF)) {
            let nginxConf = fs.readFileSync(config.NGINX_CONF, "utf8");
            nginxConf = nginxConf.replace(new RegExp(`^${sessionId}\\s+\\d+;\\n?`, "m"), "");
            fs.writeFileSync(config.NGINX_CONF, nginxConf);
        }

        // 4️⃣ Hapus folder session
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }

        // 5️⃣ Reload nginx
        execSync(`sudo nginx -t && sudo nginx -s reload`, { stdio: "inherit" });

        res.json({ success: true, sessionId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to delete session", details: err.message });
    }
});

app.listen(4000, () => {
    console.log("Session Manager running on 127.0.0.1:4000");
});