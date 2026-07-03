import json,urllib.request,urllib.error,time
API="http://localhost:8000/api/v1"; PIPE="http://localhost:5280"
def req(base,m,p,b=None,t=40):
    data=json.dumps(b).encode() if b is not None else None
    r=urllib.request.Request(base+p,data=data,headers={"Content-Type":"application/json"} if data else {},method=m)
    try:
        with urllib.request.urlopen(r,timeout=t) as x:return x.status,json.loads(x.read())
    except urllib.error.HTTPError as e:
        try:return e.code,json.loads(e.read().decode() or "{}")
        except:return e.code,{}
def A(m,p,b=None,t=260): return req(API,m,p,b,t)
def items(p): return (A("GET",p)[1].get("data") or {}).get("items",[])

# ① 锁定视觉词典(经 pipeline)
print(">> ① 锁定视觉词典 …")
_,j=req(PIPE,"POST","/pipeline/visual-dict",{"pid":"proj_echo"})
jid=j["job_id"]
for _ in range(180):
    time.sleep(3);_,s=req(PIPE,"GET",f"/pipeline/jobs/{jid}")
    if s.get("status") in("done","error"):print("  词典:",s.get("status"),s.get("error",""));break

# 验证年代感
vd=json.load(open("/d/CC/projects/duanju-studio/bridge/visual-dict-proj_echo.json",encoding="utf-8"))
print("  era_note:",vd.get("era_note","(无)")[:120])
cos_by=lambda arr,n:next((x for x in arr if x["name"]==n),{})
print("  小周服装:",cos_by(vd.get("characters",[]),"小周").get("costume","")[:80])

# ② 设计稿风格重生成
DP={"character":"角色设定图，全身，纯净中性背景，居中，清晰完整展示角色外貌、发型与服装细节，概念设计稿风格，均匀光照，非叙事镜头。主体：",
    "scene":"场景设计图/概念设定图，完整呈现该空间整体形态结构与布局，清晰交代关键陈设与材质细节，设定集广角、均匀光，非分镜。空间：",
    "prop":"道具设计图，纯净中性背景，主体居中，完整清晰展示道具整体形态、材质与特定细节(刻痕/锈迹/文字)，产品/设定集视角。道具："}
def visual(d): return (d or "").split("【表演基线】")[0].strip()
def ent(t,eid): return A("GET",f"/studio/entities/{t}/{eid}")[1].get("data",{})
def slot(t,eid):
    im=items(f"/studio/entities/{t}/{eid}/images")
    if im: return im[0]["id"]
    return A("POST",f"/studio/entities/{t}/{eid}/images",{"view_angle":"FRONT","quality_level":"LOW"})[1].get("data",{}).get("id")
def gen(t,eid,prompt):
    sid=slot(t,eid)
    path=f"/studio/image-tasks/characters/{eid}/image-tasks" if t=="character" else f"/studio/image-tasks/assets/{t}/{eid}/image-tasks"
    c,r=A("POST",path,{"image_id":sid,"prompt":prompt})
    tid=(r.get("data") or {}).get("task_id")
    if not tid: print(f"  {t} {eid} 任务失败:",r.get("message"));return
    st=None
    for _ in range(70):
        time.sleep(3);_,s=A("GET",f"/film/tasks/{tid}/status");st=(s.get("data") or {}).get("status")
        if st in("succeeded","failed","cancelled"):break
    print(f"  {t} {eid}: {st}")

print(">> ② 设计稿重生成 …")
# 场景
sc=ent("scene","proj_echo__scene_001");gen("scene","proj_echo__scene_001",DP["scene"]+visual(sc.get("description")))
# 道具铁盒
pr=ent("prop","proj_echo__prop_001");gen("prop","proj_echo__prop_001",DP["prop"]+visual(pr.get("description")))
# 角色周诚(穿服装)
ch=ent("character","proj_echo__char_001")
cosd=ent("costume",ch.get("costume_id")).get("description","") if ch.get("costume_id") else ""
p=DP["character"]+visual(ch.get("description"))+ ("。身着服装："+visual(cosd) if cosd else "")
gen("character","proj_echo__char_001",p)
print(">> 完成")
