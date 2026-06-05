const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_FILE = path.join(ROOT, "..", "..", "work", "job-portal-db.json");

const sessions = new Map();

const seedDb = {
  users: [],
  applications: [],
  supportTickets: [],
  jobs: [
    {
      id: "job-1",
      title: "Frontend Developer",
      company: "SkyLine Labs",
      location: "Remote",
      type: "Full-time",
      salary: "$84k - $118k",
      tags: ["React", "CSS", "UI"],
      summary: "Build bright, polished experiences for a fast-growing hiring platform.",
    },
    {
      id: "job-2",
      title: "Node.js Backend Engineer",
      company: "BluePeak Systems",
      location: "San Francisco, CA",
      type: "Hybrid",
      salary: "$96k - $132k",
      tags: ["Node.js", "APIs", "PostgreSQL"],
      summary: "Own secure APIs, file-backed services, and hiring workflows at scale.",
    },
    {
      id: "job-3",
      title: "Talent Operations Specialist",
      company: "WhiteWave Careers",
      location: "Austin, TX",
      type: "On-site",
      salary: "$62k - $88k",
      tags: ["Hiring", "Support", "Coordination"],
      summary: "Guide candidates, manage pipeline details, and keep operations moving.",
    },
  ],
};

async function ensureDataFile() {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, JSON.stringify(seedDb, null, 2), "utf8");
  }
}

async function readDb() {
  await ensureDataFile();
  const raw = await fs.readFile(DATA_FILE, "utf8");
  return JSON.parse(raw);
}

async function writeDb(db) {
  await fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
}

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
  res.end(body);
}

function sendJson(res, statusCode, data, headers = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(JSON.stringify(data));
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function parseCookies(cookieHeader = "") {
  return cookieHeader.split(";").reduce((acc, pair) => {
    const index = pair.indexOf("=");
    if (index > -1) {
      const key = pair.slice(0, index).trim();
      const value = decodeURIComponent(pair.slice(index + 1).trim());
      acc[key] = value;
    }
    return acc;
  }, {});
}

function getSessionUser(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies.portal_session;
  if (!token) return null;
  return sessions.get(token) || null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        const contentType = req.headers["content-type"] || "";
        if (contentType.includes("application/json")) {
          resolve(JSON.parse(data));
          return;
        }
        const params = new URLSearchParams(data);
        resolve(Object.fromEntries(params.entries()));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function serveStatic(res, urlPath) {
  const target = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, target));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    send(res, 403, "Forbidden");
    return true;
  }
  try {
    const file = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const typeMap = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
    };
    res.writeHead(200, {
      "Content-Type": typeMap[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(file);
    return true;
  } catch {
    return false;
  }
}

async function handleApi(req, res, pathname) {
  const db = await readDb();

  if (req.method === "GET" && pathname === "/api/jobs") {
    return sendJson(res, 200, { jobs: db.jobs });
  }

  if (req.method === "GET" && pathname === "/api/me") {
    const user = getSessionUser(req);
    return sendJson(res, 200, { user });
  }

  if (req.method === "POST" && pathname === "/api/register") {
    const body = await readBody(req);
    const { name, email, password, phone, location, role, desiredRole, experience, portfolio, headline } = body;
    if (!name || !email || !password) {
      return sendJson(res, 400, { error: "Name, email, and password are required." });
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    if (db.users.some((user) => user.email === normalizedEmail)) {
      return sendJson(res, 409, { error: "An account already exists for that email." });
    }
    const user = {
      id: crypto.randomUUID(),
      name: String(name).trim(),
      email: normalizedEmail,
      passwordHash: hashPassword(String(password)),
      phone: phone ? String(phone).trim() : "",
      location: location ? String(location).trim() : "",
      role: role ? String(role).trim() : "Candidate",
      desiredRole: desiredRole ? String(desiredRole).trim() : "",
      experience: experience ? String(experience).trim() : "",
      portfolio: portfolio ? String(portfolio).trim() : "",
      headline: headline ? String(headline).trim() : "",
      createdAt: new Date().toISOString(),
    };
    db.users.push(user);
    await writeDb(db);
    const token = crypto.randomUUID();
    sessions.set(token, {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    });
    return sendJson(
      res,
      201,
      {
        user: sessions.get(token),
        message: "Registration successful.",
      },
      {
        "Set-Cookie": `portal_session=${token}; HttpOnly; Path=/; SameSite=Lax`,
      }
    );
  }

  if (req.method === "POST" && pathname === "/api/login") {
    const body = await readBody(req);
    const { email, password } = body;
    if (!email || !password) {
      return sendJson(res, 400, { error: "Email and password are required." });
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const user = db.users.find((item) => item.email === normalizedEmail);
    if (!user || user.passwordHash !== hashPassword(String(password))) {
      return sendJson(res, 401, { error: "Invalid email or password." });
    }
    const token = crypto.randomUUID();
    sessions.set(token, {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    });
    return sendJson(
      res,
      200,
      {
        user: sessions.get(token),
        message: "Login successful.",
      },
      {
        "Set-Cookie": `portal_session=${token}; HttpOnly; Path=/; SameSite=Lax`,
      }
    );
  }

  if (req.method === "POST" && pathname === "/api/logout") {
    const cookies = parseCookies(req.headers.cookie || "");
    const token = cookies.portal_session;
    if (token) sessions.delete(token);
    return sendJson(
      res,
      200,
      { message: "Logged out." },
      { "Set-Cookie": "portal_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0" }
    );
  }

  if (req.method === "POST" && pathname === "/api/apply") {
    const body = await readBody(req);
    const user = getSessionUser(req);
    const payload = {
      id: crypto.randomUUID(),
      fullName: body.fullName ? String(body.fullName).trim() : user?.name || "",
      email: body.email ? String(body.email).trim().toLowerCase() : user?.email || "",
      phone: body.phone ? String(body.phone).trim() : "",
      jobId: body.jobId ? String(body.jobId) : "",
      experience: body.experience ? String(body.experience).trim() : "",
      location: body.location ? String(body.location).trim() : "",
      resume: body.resume ? String(body.resume).trim() : "",
      coverLetter: body.coverLetter ? String(body.coverLetter).trim() : "",
      skills: body.skills ? String(body.skills).trim() : "",
      message: body.message ? String(body.message).trim() : "",
      createdAt: new Date().toISOString(),
      submittedBy: user ? user.id : null,
    };
    if (!payload.fullName || !payload.email || !payload.jobId) {
      return sendJson(res, 400, { error: "Full name, email, and job selection are required." });
    }
    db.applications.push(payload);
    await writeDb(db);
    return sendJson(res, 201, { message: "Application submitted successfully." });
  }

  if (req.method === "POST" && pathname === "/api/support") {
    const body = await readBody(req);
    const payload = {
      id: crypto.randomUUID(),
      name: body.name ? String(body.name).trim() : "",
      email: body.email ? String(body.email).trim().toLowerCase() : "",
      phone: body.phone ? String(body.phone).trim() : "",
      category: body.category ? String(body.category).trim() : "General",
      message: body.message ? String(body.message).trim() : "",
      createdAt: new Date().toISOString(),
    };
    if (!payload.name || !payload.email || !payload.message) {
      return sendJson(res, 400, { error: "Name, email, and message are required." });
    }
    db.supportTickets.push(payload);
    await writeDb(db);
    return sendJson(res, 201, { message: "Your problem has been sent to support." });
  }

  return sendJson(res, 404, { error: "Not found." });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (pathname.startsWith("/api/")) {
    try {
      return await handleApi(req, res, pathname);
    } catch (error) {
      console.error(error);
      return sendJson(res, 500, { error: "Server error." });
    }
  }

  if (pathname === "/login") {
    return serveStatic(res, "/login.html");
  }

  if (pathname === "/register") {
    return serveStatic(res, "/register.html");
  }

  try {
    const served = await serveStatic(res, pathname);
    if (!served) {
      const fallback = pathname === "/" ? "/index.html" : null;
      if (fallback) {
        const handled = await serveStatic(res, fallback);
        if (handled) return;
      }
      send(res, 404, "Page not found.");
    }
  } catch (error) {
    console.error(error);
    send(res, 500, "Server error.");
  }
}

async function start() {
  await ensureDataFile();
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`Job portal running at http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
