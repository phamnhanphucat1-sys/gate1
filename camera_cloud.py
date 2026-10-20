"""Copy next to camera.py. Set GATE_URL and GATE_TOKEN in CMD."""
import os,time,json,uuid,base64,threading,urllib.request
from pathlib import Path
from datetime import datetime,timezone
ROOT=Path(__file__).resolve().parent/'outbox'
ROOT.mkdir(exist_ok=True)
_last=0
_lock=threading.Lock()
def record_suspected(frame):
    global _last
    with _lock:
        if time.monotonic()-_last<30:return
        import cv2
        if frame.shape[1]>960:frame=cv2.resize(frame,(960,int(frame.shape[0]*960/frame.shape[1])))
        ok,b=cv2.imencode('.jpg',frame,[cv2.IMWRITE_JPEG_QUALITY,75])
        if not ok:return
        ident=str(uuid.uuid4())
        payload={'event_id':ident,'time':datetime.now(timezone.utc).isoformat(),'kind':'Nghi không đội mũ','note':'Camera cổng trường — cần xem ảnh xác nhận','image':base64.b64encode(b).decode()}
        temp=ROOT/(ident+'.tmp');temp.write_text(json.dumps(payload),encoding='utf-8');temp.replace(ROOT/(ident+'.json'))
        _last=time.monotonic()
        print('Da luu su kien vao hang doi. So ban ghi cho gui:',len(list(ROOT.glob('*.json'))))
def worker():
    while True:
        url=os.environ.get('GATE_URL','').rstrip('/');token=os.environ.get('GATE_TOKEN','')
        if url and token:
            for p in sorted(ROOT.glob('*.json')):
                try:
                    req=urllib.request.Request(url+'/api/events',data=p.read_bytes(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
                    with urllib.request.urlopen(req,timeout=15) as r:r.read()
                    p.unlink();print('Da gui su kien len web.')
                except Exception as e:
                    print('Chua gui duoc, se thu lai:',e);break
        time.sleep(5)
threading.Thread(target=worker,daemon=True).start()
