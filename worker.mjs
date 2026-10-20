const VALID_STATUSES = [
  "Cho kiem tra",
  "Da xac nhan",
  "Nhan nham"
];

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

async function secretEqual(a, b) {
  const encode = value => new TextEncoder().encode(String(value));

  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encode(a)),
    crypto.subtle.digest("SHA-256", encode(b))
  ]);

  const x = new Uint8Array(left);
  const y = new Uint8Array(right);

  let difference = 0;

  for (let i = 0; i < x.length; i++) {
    difference |= x[i] ^ y[i];
  }

  return difference === 0;
}

function isAdmin(request, env) {
  if (!env.SESSION_KEY) return false;

  return (request.headers.get("Cookie") || "")
    .split(";")
    .some(part => part.trim() === `gate=${env.SESSION_KEY}`);
}

async function readBody(request, maxBytes = 3000000) {
  const declared = Number(request.headers.get("Content-Length") || 0);

  if (declared > maxBytes) {
    throw new Error("Dữ liệu quá lớn.");
  }

  const reader = request.body?.getReader();
  if (!reader) throw new Error("Thiếu dữ liệu.");

  const chunks = [];
  let length = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      length += value.byteLength;

      if (length > maxBytes) {
        await reader.cancel();
        throw new Error("Dữ liệu quá lớn.");
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return JSON.parse(new TextDecoder().decode(bytes));
}

function eventTime(value) {
  const date = value ? new Date(value) : new Date();

  if (!Number.isFinite(date.getTime())) {
    throw new Error("Thời gian không hợp lệ.");
  }

  return {
    time: date.toISOString(),
    day: new Date(date.getTime() + 7 * 3600000)
      .toISOString()
      .slice(0, 10)
  };
}

function eventKind(value) {
  const kind = String(value || "").trim().slice(0, 100);

  if (!kind) throw new Error("Vui lòng nhập loại sự kiện.");

  return kind;
}

function eventStatus(value) {
  if (!VALID_STATUSES.includes(value)) {
    throw new Error("Trạng thái không hợp lệ.");
  }

  return value;
}

function eventId(value) {
  const id = Number(value);

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("ID không hợp lệ.");
  }

  return id;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Trang giao diện được xem công khai.
      if (!path.startsWith("/api/") && !path.startsWith("/images/")) {
        return env.ASSETS.fetch(request);
      }

      // Các thao tác từ trình duyệt phải cùng nguồn.
      if (request.method === "POST") {
        const origin = request.headers.get("Origin");

        if (origin && origin !== url.origin) {
          return json({ error: "Nguồn yêu cầu không hợp lệ." }, 403);
        }
      }

      const admin = isAdmin(request, env);

      // Kiểm tra phiên admin; không bắt khách đăng nhập.
      if (path === "/api/me" && request.method === "GET") {
        return json({ admin });
      }

      if (path === "/api/login" && request.method === "POST") {
        if (!env.ADMIN_PASSWORD || !env.SESSION_KEY) {
          return json({ error: "Chưa cấu hình secrets đăng nhập." }, 503);
        }

        const body = await readBody(request, 2000);

        if (
          typeof body.password !== "string" ||
          !(await secretEqual(body.password, env.ADMIN_PASSWORD))
        ) {
          return json({ error: "Mã quản trị không đúng." }, 401);
        }

        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Set-Cookie":
              `gate=${env.SESSION_KEY}; HttpOnly; Secure; ` +
              "SameSite=Strict; Path=/; Max-Age=43200"
          }
        });
      }

      if (path === "/api/logout" && request.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Set-Cookie":
              "gate=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"
          }
        });
      }

      // Ảnh được phép xem công khai.
      if (path.startsWith("/images/") && request.method === "GET") {
        const key = path.slice("/images/".length);

        if (!/^[a-f0-9-]{36}\.jpg$/.test(key)) {
          return json({ error: "Không tìm thấy ảnh." }, 404);
        }

        const object = await env.PHOTOS.get(key);

        if (!object) {
          return json({ error: "Không tìm thấy ảnh." }, 404);
        }

        return new Response(object.body, {
          headers: {
            "Content-Type": "image/jpeg",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
          }
        });
      }

      const day = url.searchParams.get("day") || "";

      if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        return json({ error: "Ngày không hợp lệ." }, 400);
      }

      // Khách được xem lịch sử theo ngày.
      if (path === "/api/days" && request.method === "GET") {
        const result = await env.DB.prepare(
          "SELECT day, COUNT(*) AS count FROM events " +
          "GROUP BY day ORDER BY day DESC"
        ).all();

        return json(result.results);
      }

      // Khách được xem sự kiện. CSV dành cho admin.
      if (
        request.method === "GET" &&
        (path === "/api/events" || path === "/api/export")
      ) {
        if (path === "/api/export" && !admin) {
          return json({ error: "Cần đăng nhập admin." }, 401);
        }

        const statement = env.DB.prepare(
          "SELECT id,time,day,kind,note,status,image FROM events " +
          (day ? "WHERE day=? " : "") +
          "ORDER BY time DESC,id DESC LIMIT 2000"
        );

        const result = await (
          day ? statement.bind(day) : statement
        ).all();

        if (path === "/api/events") {
          return json(result.results);
        }

        const fields = ["id", "time", "day", "kind", "note", "status"];

        function escapeCSV(value) {
          let text = String(value ?? "");

          if (/^[=+@\-\t\r]/.test(text)) {
            text = "'" + text;
          }

          return '"' + text.replaceAll('"', '""') + '"';
        }

        const csv = "\ufeff" + [
          fields.join(","),
          ...result.results.map(row =>
            fields.map(field => escapeCSV(row[field])).join(",")
          )
        ].join("\r\n");

        return new Response(csv, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="events.csv"',
            "Cache-Control": "no-store"
          }
        });
      }

      // Ngoài các đường đọc công khai, mọi thay đổi đều cần xác thực.
      if (request.method !== "POST") {
        return json({ error: "Không tìm thấy." }, 404);
      }

      const camera =
        path === "/api/events" &&
        !!env.CAMERA_TOKEN &&
        await secretEqual(
          request.headers.get("Authorization") || "",
          `Bearer ${env.CAMERA_TOKEN}`
        );

      if (!admin && !camera) {
        return json({ error: "Cần đăng nhập admin." }, 401);
      }

      // Cookie admin chỉ dùng cho yêu cầu cùng nguồn.
      if (
        admin &&
        !camera &&
        request.headers.get("Origin") !== url.origin
      ) {
        return json({ error: "Nguồn yêu cầu không hợp lệ." }, 403);
      }

      const body = await readBody(request);

      // Admin hoặc camera được tạo sự kiện.
      if (path === "/api/events") {
        const uuid = body.event_id || crypto.randomUUID();

        if (!/^[a-f0-9-]{36}$/.test(uuid)) {
          return json({ error: "Mã sự kiện không hợp lệ." }, 400);
        }

        const existing = await env.DB.prepare(
          "SELECT id FROM events WHERE event_id=?"
        ).bind(uuid).first();

        if (existing) {
          return json({ id: existing.id, duplicate: true });
        }

        const stamp = eventTime(body.time);
        const kind = eventKind(body.kind || "Nghi không đội mũ");
        const note = String(body.note || "").slice(0, 1000);

        // Camera không được tự xác nhận kết quả.
        const status = admin && !camera
          ? eventStatus(body.status || "Cho kiem tra")
          : "Cho kiem tra";

        let image = "";

        if (body.image) {
          const raw = atob(body.image);

          if (
            raw.length > 2000000 ||
            raw.charCodeAt(0) !== 255 ||
            raw.charCodeAt(1) !== 216
          ) {
            return json({ error: "Cần ảnh JPEG dưới 2 MB." }, 400);
          }

          image = uuid + ".jpg";

          await env.PHOTOS.put(
            image,
            Uint8Array.from(raw, character => character.charCodeAt(0)),
            { httpMetadata: { contentType: "image/jpeg" } }
          );
        }

        await env.DB.prepare(
          "INSERT OR IGNORE INTO events " +
          "(event_id,time,day,kind,note,status,image) " +
          "VALUES(?,?,?,?,?,?,?)"
        ).bind(
          uuid,
          stamp.time,
          stamp.day,
          kind,
          note,
          status,
          image
        ).run();

        const saved = await env.DB.prepare(
          "SELECT id FROM events WHERE event_id=?"
        ).bind(uuid).first();

        return json({ id: saved.id }, 201);
      }

      // Token camera không được sửa, xóa hay xác nhận.
      if (!admin) {
        return json({ error: "Chỉ admin được thực hiện." }, 403);
      }

      const id = eventId(body.id);

      if (path === "/api/update") {
        const existing = await env.DB.prepare(
          "SELECT id FROM events WHERE id=?"
        ).bind(id).first();

        if (!existing) {
          return json({ error: "Sự kiện không tồn tại." }, 404);
        }

        const stamp = eventTime(body.time);
        const kind = eventKind(body.kind);
        const note = String(body.note || "").slice(0, 1000);
        const status = eventStatus(body.status);

        await env.DB.prepare(
          "UPDATE events SET time=?,day=?,kind=?,note=?,status=? WHERE id=?"
        ).bind(
          stamp.time,
          stamp.day,
          kind,
          note,
          status,
          id
        ).run();

        return json({ ok: true });
      }

      if (path === "/api/status") {
        const status = eventStatus(body.status);

        await env.DB.prepare(
          "UPDATE events SET status=? WHERE id=?"
        ).bind(status, id).run();

        return json({ ok: true });
      }

      if (path === "/api/delete") {
        const existing = await env.DB.prepare(
          "SELECT image FROM events WHERE id=?"
        ).bind(id).first();

        if (existing?.image) {
          await env.PHOTOS.delete(existing.image);
        }

        await env.DB.prepare(
          "DELETE FROM events WHERE id=?"
        ).bind(id).run();

        return json({ ok: true });
      }

      return json({ error: "Không tìm thấy." }, 404);
    } catch (error) {
      console.error(error);

      return json({
        error: "Không xử lý được yêu cầu. Kiểm tra dữ liệu và cấu hình máy chủ."
      }, 400);
    }
  }
};
