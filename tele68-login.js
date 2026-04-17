const WebSocket = require("ws");

const LOGIN_WS = "wss://wminidevdaigia.tele68.com/websocket";

// Encode string với length prefix
function encodeString(str) {
  const buf = Buffer.from(str, "utf8");
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(buf.length);
  return Buffer.concat([lenBuf, buf]);
}

// Build login packet: 90 00 [len] 01 00 01 00 [username] 00 [password]
function buildLoginPacket(username, password) {
  const userBuf = encodeString(username);
  const passBuf = encodeString(password);
  const sep = Buffer.from([0x00]);
  const payload = Buffer.concat([
    Buffer.from([0x01, 0x00, 0x01, 0x00]),
    userBuf,
    sep,
    passBuf
  ]);
  const header = Buffer.from([0x90, 0x00]);
  const lenBuf = Buffer.alloc(1);
  lenBuf.writeUInt8(payload.length);
  return Buffer.concat([header, lenBuf, payload]);
}

function loginWS(username, password) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(LOGIN_WS, {
      headers: {
        "Origin": "https://lc79b.bet",
        "Referer": "https://lc79b.bet/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Login timeout"));
    }, 10000);

    ws.on("open", () => {
      console.log("[LOGIN] Đã kết nối, gửi thông tin đăng nhập...");
      const packet = buildLoginPacket(username, password);
      console.log("[LOGIN] Packet:", packet.toString("hex"));
      ws.send(packet);
    });

    ws.on("message", (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      console.log("[LOGIN] Response hex:", buf.toString("hex"));
      console.log("[LOGIN] Response str:", buf.toString());

      // Parse response: tìm accessToken (32 hex chars)
      const str = buf.toString();
      const tokenMatch = str.match(/[0-9a-f]{32}/i);
      if (tokenMatch) {
        clearTimeout(timeout);
        ws.close();
        resolve(tokenMatch[0]);
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    ws.on("close", () => clearTimeout(timeout));
  });
}

module.exports = { loginWS };
