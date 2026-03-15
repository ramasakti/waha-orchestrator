const express = require("express");
const fs = require("fs");
const { execSync } = require("child_process");
const path = require("path");

const config = require("./config");
const stateFile = path.join(__dirname, "state.json");

const app = express();
app.use(express.json());

function loadState() {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

function saveState(state) {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function validSessionId(id) {
    return /^[a-z0-9_-]+$/.test(id);
}

app.post("/sessions", (req, res) => {
    const { sessionId } = req.body;
    console.log(sessionId, validSessionId(sessionId))

    if (!sessionId || !validSessionId(sessionId)) {
        return res.status(400).json({ error: "Invalid sessionId" });
    }

    const sessionDir = path.join(config.SESSIONS_DIR, sessionId);
    if (fs.existsSync(sessionDir)) {
        return res.status(409).json({ error: "Session already exists" });
    }

    const state = loadState();
    const port = state.lastPort + 1;

    try {
        // 1. Buat folder session
        fs.mkdirSync(sessionDir, { recursive: true });

        // 2. Append docker-compose service
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

        fs.appendFileSync(config.COMPOSE_FILE, serviceBlock);

        // 3. Update nginx map
        const nginxAppend = `
    ${sessionId}  ${port};
`;
        fs.appendFileSync(config.NGINX_CONF, nginxAppend);

        // 4. Jalankan container
        execSync(`cd ${config.WAHA_ROOT} && docker compose up -d waha-${sessionId}`, { stdio: "inherit" });

        // 5. Reload nginx
        execSync(`nginx -t && nginx -s reload`, { stdio: "inherit" });

        // 6. Update state
        state.lastPort = port;
        saveState(state);

        res.json({
            success: true,
            sessionId,
            port
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to create session" });
    }
});

app.listen(4000, () => {
    console.log("Session Manager running on 127.0.0.1:4000");
});
