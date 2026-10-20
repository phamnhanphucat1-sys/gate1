const json=(v,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store'}});
async function equal(a,b){const hash=s=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));const [x,y]=await Promise.all([hash(a),hash(b)]);let diff=0;const v=new Uint8Array(y);new Uint8Array(x).forEach((n,i)=>diff|=n^v[i]);return diff===0}
export default {async fetch(req,env){
 const u=new URL(req.url),p=u.pathname;
 try {
 if(p==='/api/login'&&req.method==='POST'){
  if(!env.ADMIN_PASSWORD||!env.SESSION_KEY)return json({error:'Chưa cấu hình secrets'},503);
  if(Number(req.headers.get('content-length'))>2000)return json({error:'Quá lớn'},413);
  const b=await req.json();if(typeof b.password!=='string'||!await equal(b.password,env.ADMIN_PASSWORD))return json({error:'Mật khẩu không đúng'},401);
  return new Response('{}',{headers:{'Content-Type':'application/json','Set-Cookie':`gate=${env.SESSION_KEY}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`,'Cache-Control':'no-store'}});
 }
 if(p==='/api/logout')return new Response('{}',{headers:{'Set-Cookie':'gate=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'}});
 if(!p.startsWith('/api/')&&!p.startsWith('/images/'))return env.ASSETS.fetch(req);
 const session=(req.headers.get('Cookie')||'').split(';').some(x=>x.trim()===`gate=${env.SESSION_KEY}`);
 const camera=p==='/api/events'&&req.method==='POST'&&env.CAMERA_TOKEN&&await equal(req.headers.get('Authorization')||'',`Bearer ${env.CAMERA_TOKEN}`);
 if(!(env.SESSION_KEY&&session)&&!camera)return json({error:'Vui lòng đăng nhập'},401);
 if(req.method!=='GET'&&session&&!camera&&req.headers.get('Origin')!==u.origin)return json({error:'Origin không hợp lệ'},403);
 if(p.startsWith('/images/')&&req.method==='GET'){
  const name=p.slice(8);if(!/^[a-f0-9-]{36}\.jpg$/.test(name))return json({},404);
  const obj=await env.PHOTOS.get(name);return obj?new Response(obj.body,{headers:{'Content-Type':'image/jpeg','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}}):json({},404);
 }
 const day=u.searchParams.get('day')||'';if(day&&!/^\d{4}-\d{2}-\d{2}$/.test(day))return json({error:'Ngày không hợp lệ'},400);
 if(p==='/api/days')return json((await env.DB.prepare('SELECT day,COUNT(*) count FROM events GROUP BY day ORDER BY day DESC').all()).results);
 if((p==='/api/events'||p==='/api/export')&&req.method==='GET'){
  const stmt=env.DB.prepare('SELECT * FROM events '+(day?'WHERE day=? ':'')+'ORDER BY time DESC LIMIT 2000');const rs=(await (day?stmt.bind(day):stmt).all()).results;
  if(p==='/api/events')return json(rs);
  const keys=['id','time','day','kind','note','status'];const esc=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';
  return new Response('\ufeff'+[keys.join(','),...rs.map(r=>keys.map(k=>esc(r[k])).join(','))].join('\r\n'),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="events.csv"','Cache-Control':'no-store'}});
 }
 if(req.method==='POST'){
  if(Number(req.headers.get('Content-Length'))>3000000)return json({error:'Ảnh quá lớn'},413);
  const text=await req.text();if(text.length>3000000)return json({error:'Dữ liệu quá lớn'},413);const b=JSON.parse(text);
  if(p==='/api/events'){
   const id=b.event_id||crypto.randomUUID();if(!/^[a-f0-9-]{36}$/.test(id))return json({error:'ID không hợp lệ'},400);
   const old=await env.DB.prepare('SELECT id FROM events WHERE event_id=?').bind(id).first();if(old)return json({id:old.id,duplicate:true});
   const now=b.time?new Date(b.time):new Date();if(!Number.isFinite(now.getTime()))return json({error:'Thời gian không hợp lệ'},400);
   const day=new Date(now.getTime()+7*3600000).toISOString().slice(0,10);let image='';
   if(b.image){const raw=atob(b.image);if(raw.length>2000000||raw.charCodeAt(0)!==255||raw.charCodeAt(1)!==216)return json({error:'Cần ảnh JPEG dưới 2 MB'},400);image=id+'.jpg';await env.PHOTOS.put(image,Uint8Array.from(raw,c=>c.charCodeAt(0)),{httpMetadata:{contentType:'image/jpeg'}})}
   // Unique event_id makes client retries idempotent.
   await env.DB.prepare('INSERT OR IGNORE INTO events(event_id,time,day,kind,note,status,image) VALUES(?,?,?,?,?,?,?)').bind(id,now.toISOString(),day,String(b.kind||'Nghi không đội mũ').slice(0,100),String(b.note||'').slice(0,1000),'Cho kiem tra',image).run();
   const r=await env.DB.prepare('SELECT id FROM events WHERE event_id=?').bind(id).first();return json({id:r.id},201);
  }
  if(p==='/api/status'){
   if(!['Cho kiem tra','Da xac nhan','Nhan nham'].includes(b.status))return json({error:'Trạng thái không hợp lệ'},400);
   await env.DB.prepare('UPDATE events SET status=? WHERE id=?').bind(b.status,b.id).run();return json({ok:true});
  }
  if(p==='/api/delete'){
   const r=await env.DB.prepare('SELECT image FROM events WHERE id=?').bind(b.id).first();if(r?.image)await env.PHOTOS.delete(r.image);
   await env.DB.prepare('DELETE FROM events WHERE id=?').bind(b.id).run();return json({ok:true});
  }
 }
 return json({error:'Không tìm thấy'},404);
 }catch(e){console.error(e);return json({error:'Không xử lý được yêu cầu. Kiểm tra cấu hình hoặc dữ liệu.'},400)}
}};
