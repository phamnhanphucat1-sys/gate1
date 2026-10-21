const STATUSES = [
  "Cho kiem tra",
  "Da xac nhan",
  "Nhan nham"
];

const MAX_JSON_BYTES = 3_000_000;
const MAX_JPEG_BYTES = 2_000_000;
const MAX_PNG_BYTES = 8_000_000;

function json(value, status = 200, extraHeaders = {}) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function equal(a, b) {
  const encode = new TextEncoder();

  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", encode.encode(a)),
    crypto.subtle.digest("SHA-256", encode.encode(b))
  ]);

  const first = new Uint8Array(x);
  const second = new Uint8Array(y);

  let difference = 0;

  for (let i = 0; i < first.length; i++) {
    difference |= first[i] ^ second[i];
  }

  return difference === 0;
}

async function isAdmin(request, env) {
  if (!env.SESSION_KEY) return false;

  const cookies = (request.headers.get("Cookie") || "")
    .split(";")
    .map(item => item.trim());

  for (const cookie of cookies) {
    if (!cookie.startsWith("gate=")) continue;

    const value = cookie.slice(5);

    if (await equal(value, env.SESSION_KEY)) {
      return true;
    }
  }

  return false;
}

async function isCamera(request, env, pathname) {
  if (
    pathname !== "/api/events" ||
    request.method !== "POST" ||
    !env.CAMERA_TOKEN
  ) {
    return false;
  }

  return equal(
    request.headers.get("Authorization") || "",
    `Bearer ${env.CAMERA_TOKEN}`
  );
}

function checkOrigin(request, url) {
  if (request.headers.get("Origin") !== url.origin) {
    throw fail("Nguồn yêu cầu không hợp lệ.", 403);
  }
}

async function readBytes(request, limit) {
  const length = Number(request.headers.get("Content-Length"));

  if (length > limit) {
    throw fail("Dữ liệu vượt quá kích thước cho phép.", 413);
  }

  const reader = request.body?.getReader();

  if (!reader) {
    throw fail("Thiếu dữ liệu yêu cầu.");
  }

  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) break;

    total += value.byteLength;

    if (total > limit) {
      await reader.cancel();
      throw fail("Dữ liệu vượt quá kích thước cho phép.", 413);
    }

    chunks.push(value);
  }

  const result = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result;
}

async function readJSON(request, limit = MAX_JSON_BYTES) {
  const bytes = await readBytes(request, limit);

  let body;

  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch (_) {
    throw fail("Dữ liệu JSON không hợp lệ.");
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    throw fail("Nội dung yêu cầu không hợp lệ.");
  }

  return body;
}

function eventID(value) {
  const id = String(value ?? "");

  if (!/^[1-9]\d*$/.test(id)) {
    throw fail("ID sự kiện không hợp lệ.");
  }

  return id;
}

function annotationKey(id) {
  return "annotations/" + id + ".png";
}

function getTime(value) {
  const time = value === undefined || value === ""
    ? new Date()
    : new Date(value);

  if (!Number.isFinite(time.getTime())) {
    throw fail("Thời gian không hợp lệ.");
  }

  return {
    time: time.toISOString(),
    day: new Date(time.getTime() + 7 * 3600000)
      .toISOString()
      .slice(0, 10)
  };
}

function getStatus(value, fallback = "Cho kiem tra") {
  const status = value === undefined ? fallback : value;

  if (!STATUSES.includes(status)) {
    throw fail("Trạng thái không hợp lệ.");
  }

  return status;
}

function getKind(value) {
  const kind = String(value ?? "Nghi không đội mũ").trim();

  if (!kind || kind.length > 100) {
    throw fail("Loại sự kiện cần từ 1 đến 100 ký tự.");
  }

  return kind;
}

function getNote(value) {
  const note = String(value ?? "");

  if (note.length > 1000) {
    throw fail("Ghi chú tối đa 1.000 ký tự.");
  }

  return note;
}

function decodeJPEG(value) {
  if (typeof value !== "string") {
    throw fail("Ảnh cần là chuỗi JPEG dạng base64.");
  }

  let raw;

  try {
    raw = atob(value);
  } catch (_) {
    throw fail("Dữ liệu ảnh base64 không hợp lệ.");
  }

  if (
    raw.length < 3 ||
    raw.length > MAX_JPEG_BYTES ||
    raw.charCodeAt(0) !== 255 ||
    raw.charCodeAt(1) !== 216 ||
    raw.charCodeAt(2) !== 255
  ) {
    throw fail("Cần ảnh JPEG tối đa 2 MB.");
  }

  return Uint8Array.from(raw, character => character.charCodeAt(0));
}

function validatePNG(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];

  if (
    bytes.length < 33 ||
    !signature.every((value, index) => bytes[index] === value)
  ) {
    throw fail("Ảnh PNG không hợp lệ.");
  }

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  );

  // PNG bắt đầu bằng chunk IHDR dài 13 byte.
  if (
    view.getUint32(8) !== 13 ||
    bytes[12] !== 73 ||
    bytes[13] !== 72 ||
    bytes[14] !== 68 ||
    bytes[15] !== 82
  ) {
    throw fail("Thông tin ảnh PNG không hợp lệ.");
  }

  const width = view.getUint32(16);
  const height = view.getUint32(20);

  if (
    !width ||
    !height ||
    width > 16384 ||
    height > 16384 ||
    width * height > 40_000_000
  ) {
    throw fail("Kích thước ảnh PNG quá lớn hoặc không hợp lệ.");
  }
}

function csvCell(value) {
  let text = String(value ?? "");

  // Tránh để nội dung được hiểu thành công thức bảng tính.
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) {
    text = "'" + text;
  }

  return '"' + text.replaceAll('"', '""') + '"';
}

async function requireEvent(env, id) {
  const event = await env.DB
    .prepare("SELECT * FROM events WHERE id=?")
    .bind(id)
    .first();

  if (!event) {
    throw fail("Không tìm thấy sự kiện.", 404);
  }

  return event;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // ================= ĐĂNG NHẬP =================

      if (path === "/api/login") {
        if (method !== "POST") {
          return json({error:"Chỉ hỗ trợ POST."}, 405);
        }

        checkOrigin(request, url);

        if (!env.ADMIN_PASSWORD || !env.SESSION_KEY) {
          return json(
            {error:"Chưa cấu hình ADMIN_PASSWORD hoặc SESSION_KEY."},
            503
          );
        }

        const body = await readJSON(request, 4096);

        if (
          typeof body.password !== "string" ||
          !await equal(body.password, env.ADMIN_PASSWORD)
        ) {
          return json({error:"Mật khẩu không đúng."}, 401);
        }

        // SESSION_KEY nên là chuỗi ngẫu nhiên dài dạng hex.
        if (!/^[A-Za-z0-9_-]{32,}$/.test(env.SESSION_KEY)) {
          return json(
            {error:"SESSION_KEY cần ít nhất 32 ký tự chữ, số, _ hoặc -."},
            503
          );
        }

        return json(
          {ok:true},
          200,
          {
            "Set-Cookie":
              `gate=${env.SESSION_KEY}; ` +
              "HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200"
          }
        );
      }

      if (path === "/api/logout") {
        if (method !== "POST") {
          return json({error:"Chỉ hỗ trợ POST."}, 405);
        }

        checkOrigin(request, url);

        return json(
          {ok:true},
          200,
          {
            "Set-Cookie":
              "gate=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"
          }
        );
      }

      if (path === "/api/me") {
        if (method !== "GET") {
          return json({error:"Chỉ hỗ trợ GET."}, 405);
        }

        return json({
          admin:await isAdmin(request, env)
        });
      }

      // ================= ẢNH GỐC CÔNG KHAI =================

      if (path.startsWith("/images/")) {
        if (method !== "GET") {
          return json({error:"Chỉ hỗ trợ GET."}, 405);
        }

        const name = path.slice("/images/".length);

        if (
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.jpg$/i
            .test(name)
        ) {
          return json({error:"Không tìm thấy ảnh."}, 404);
        }

        const object = await env.PHOTOS.get(name);

        if (!object) {
          return json({error:"Không tìm thấy ảnh."}, 404);
        }

        return new Response(object.body, {
          headers:{
            "Content-Type":"image/jpeg",
            "Cache-Control":"no-store",
            "X-Content-Type-Options":"nosniff"
          }
        });
      }

      // ================= FILE GIAO DIỆN =================

      if (!path.startsWith("/api/")) {
        return env.ASSETS.fetch(request);
      }

      // ================= ĐỌC SỰ KIỆN CÔNG KHAI =================

      if (path === "/api/days" && method === "GET") {
        const result = await env.DB.prepare(
          "SELECT day, COUNT(*) AS count " +
          "FROM events GROUP BY day ORDER BY day DESC"
        ).all();

        return json(result.results || []);
      }

      if (
        (path === "/api/events" || path === "/api/export") &&
        method === "GET"
      ) {
        if (
          path === "/api/export" &&
          !await isAdmin(request, env)
        ) {
          return json({error:"Vui lòng đăng nhập admin."}, 401);
        }

        const day = url.searchParams.get("day") || "";

        if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          throw fail("Ngày không hợp lệ.");
        }

        let statement = env.DB.prepare(
          "SELECT * FROM events " +
          (day ? "WHERE day=? " : "") +
          "ORDER BY time DESC LIMIT 2000"
        );

        if (day) {
          statement = statement.bind(day);
        }

        const result = await statement.all();
        const rows = result.results || [];

        if (path === "/api/events") {
          return json(rows);
        }

        const keys = [
          "id", "time", "day", "kind", "note", "status"
        ];

        const csv = "\ufeff" + [
          keys.join(","),
          ...rows.map(row =>
            keys.map(key => csvCell(row[key])).join(",")
          )
        ].join("\r\n");

        return new Response(csv, {
          headers:{
            "Content-Type":"text/csv; charset=utf-8",
            "Content-Disposition":
              'attachment; filename="events.csv"',
            "Cache-Control":"no-store"
          }
        });
      }

      // ================= ẢNH ĐÁNH DẤU =================

      if (path === "/api/annotation") {
        if (method !== "GET" && method !== "POST") {
          return json(
            {error:"Chỉ hỗ trợ GET hoặc POST."},
            405
          );
        }

        // Khách được xem; chỉ admin được lưu.
        if (method === "POST") {
          if (!await isAdmin(request, env)) {
            return json(
              {error:"Chỉ admin được lưu ảnh lên website."},
              401
            );
          }

          checkOrigin(request, url);

          if (
            request.headers.get("Content-Type") !== "image/png"
          ) {
            throw fail("Vui lòng gửi ảnh PNG.", 415);
          }
        }

        const id = eventID(url.searchParams.get("id"));
        const event = await requireEvent(env, id);

        if (!event.image) {
          throw fail("Sự kiện này không có ảnh gốc.", 404);
        }

        const key = annotationKey(id);

        if (method === "GET") {
          const object = await env.PHOTOS.get(key);

          if (!object) {
            return json({error:"Chưa có ảnh đánh dấu."}, 404);
          }

          return new Response(object.body, {
            headers:{
              "Content-Type":"image/png",
              "Cache-Control":"no-store",
              "X-Content-Type-Options":"nosniff"
            }
          });
        }

        const bytes = await readBytes(request, MAX_PNG_BYTES);
        validatePNG(bytes);

        await env.PHOTOS.put(key, bytes, {
          httpMetadata:{
            contentType:"image/png"
          }
        });

        return json({ok:true});
      }

      // ================= PHÂN QUYỀN GHI DỮ LIỆU =================

      const admin = await isAdmin(request, env);
      const camera = await isCamera(request, env, path);

      if (!admin && !camera) {
        return json({error:"Vui lòng đăng nhập admin."}, 401);
      }

      // Camera chỉ được thêm sự kiện bằng token.
      // Các thao tác từ trình duyệt phải cùng nguồn.
      if (method === "POST" && !camera) {
        checkOrigin(request, url);
      }

      // ================= THÊM SỰ KIỆN =================

      if (path === "/api/events" && method === "POST") {
        const body = await readJSON(request);

        const uuid = body.event_id || crypto.randomUUID();

        if (
          typeof uuid !== "string" ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
            .test(uuid)
        ) {
          throw fail("event_id cần là UUID hợp lệ.");
        }

        const old = await env.DB
          .prepare("SELECT id FROM events WHERE event_id=?")
          .bind(uuid)
          .first();

        if (old) {
          return json({
            id:old.id,
            duplicate:true
          });
        }

        const {time, day} = getTime(body.time);
        const kind = getKind(body.kind);
        const note = getNote(body.note);

        // Sự kiện do camera gửi luôn chờ kiểm tra.
        const status = camera
          ? "Cho kiem tra"
          : getStatus(body.status);

        let image = "";

        if (body.image) {
          const bytes = decodeJPEG(body.image);

          image = uuid + ".jpg";

          await env.PHOTOS.put(image, bytes, {
            httpMetadata:{
              contentType:"image/jpeg"
            }
          });
        }

        await env.DB.prepare(
          "INSERT OR IGNORE INTO events " +
          "(event_id,time,day,kind,note,status,image) " +
          "VALUES(?,?,?,?,?,?,?)"
        ).bind(
          uuid,
          time,
          day,
          kind,
          note,
          status,
          image
        ).run();

        const created = await env.DB
          .prepare("SELECT id FROM events WHERE event_id=?")
          .bind(uuid)
          .first();

        if (!created) {
          throw new Error("Không tạo được sự kiện.");
        }

        return json({id:created.id}, 201);
      }

      // Những API dưới đây bắt buộc là admin.
      if (!admin) {
        return json(
          {error:"Thao tác này chỉ dành cho admin."},
          403
        );
      }

      // ================= SỬA SỰ KIỆN =================

      if (path === "/api/update" && method === "POST") {
        const body = await readJSON(request, 16000);
        const id = eventID(body.id);

        const old = await requireEvent(env, id);

        const {time, day} = getTime(
          body.time === undefined ? old.time : body.time
        );

        const kind = getKind(
          body.kind === undefined ? old.kind : body.kind
        );

        const note = getNote(
          body.note === undefined ? old.note : body.note
        );

        const status = getStatus(body.status, old.status);

        await env.DB.prepare(
          "UPDATE events " +
          "SET time=?,day=?,kind=?,note=?,status=? " +
          "WHERE id=?"
        ).bind(
          time,
          day,
          kind,
          note,
          status,
          id
        ).run();

        return json({ok:true});
      }

      // ================= ĐỔI TRẠNG THÁI =================

      if (path === "/api/status" && method === "POST") {
        const body = await readJSON(request, 4096);
        const id = eventID(body.id);

        await requireEvent(env, id);

        if (!STATUSES.includes(body.status)) {
          throw fail("Trạng thái không hợp lệ.");
        }

        await env.DB
          .prepare("UPDATE events SET status=? WHERE id=?")
          .bind(body.status, id)
          .run();

        return json({ok:true});
      }

      // ================= XÓA SỰ KIỆN =================

      if (path === "/api/delete" && method === "POST") {
        const body = await readJSON(request, 4096);
        const id = eventID(body.id);
        const event = await requireEvent(env, id);

        // Xóa bản đánh dấu nếu có.
        await env.PHOTOS.delete(annotationKey(id));

        // Xóa ảnh gốc nếu có.
        if (event.image) {
          await env.PHOTOS.delete(event.image);
        }

        await env.DB
          .prepare("DELETE FROM events WHERE id=?")
          .bind(id)
          .run();

        return json({ok:true});
      }

      return json({error:"Không tìm thấy API."}, 404);
    } catch (error) {
      console.error(error);

      return json(
        {
          error:error.status
            ? error.message
            : "Không xử lý được yêu cầu. Kiểm tra cấu hình hoặc thử lại."
        },
        error.status || 500
      );
    }
  }
};
