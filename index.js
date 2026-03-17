const express = require("express");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const config = require("./config");

const app = express();
app.use(express.json());

const stateFile = path.join(__dirname, "state.json");

function loadState() {
    if (!fs.existsSync(stateFile)) {
        fs.writeFileSync(stateFile, JSON.stringify({ lastPort: 3100 }, null, 2));
    }
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

function saveState(state) {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
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
    console.log("Creating session:", sessionId);

    if (!sessionId || !validSessionId(sessionId)) {
        return res.status(400).json({ error: "Invalid sessionId" });
    }

    const sessionDir = path.join(config.SESSIONS_DIR, sessionId);
    if (fs.existsSync(sessionDir) || serviceExists(sessionId)) {
        return res.status(409).json({ error: "Session already exists" });
    }

    const state = loadState();
    const port = state.lastPort + 1;

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
        const serviceBlock = `
  waha-${sessionId}:
    image: devlikeapro/waha:gows
    container_name: waha-${sessionId}
    environment:
      - WAHA_SESSION=${sessionId}
    env_file:
      - .env
    volumes:
      - ./sessions/${sessionId}:/app/sessions
    ports:
      - "${port}:3000"
    restart: always
    networks:
      - waha_network
`;

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
        execSync(`cd ${config.WAHA_ROOT} && docker compose up -d waha-${sessionId}`, { stdio: "inherit" });

        // 6️⃣ Reload nginx
        execSync(`nginx -t && nginx -s reload`, { stdio: "inherit" });

        // 7️⃣ Update state
        state.lastPort = port;
        saveState(state);

        res.json({ success: true, sessionId, port });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to create session", details: err.message });
    }
});

app.listen(8081, () => {
    console.log("Session Manager running on 127.0.0.1:8081");
});