base_w = 180  # [100:5:250] base width
base_d = 120  # [80:5:200] base depth
base_t = 8  # [4:1:12] base thickness
lean_deg_from_base = 70  # [50:1:85] backrest lean from base plane
tablet_gap = 1.0  # [0.5:0.1:3] clearance each side of tablet
tablet_t = 12  # [8:1:20] tablet thickness
box_h = 30  # [15:1:50] storage box height
comp_count = 4  # [1:1:8] compartments
lid_open_deg = 0  # [0:5:110] lid opening angle

M = (Align.MIN, Align.MIN, Align.MIN)
def bx(x0,y0,z0,x1,y1,z1): return Pos(x0,y0,z0)*Box(x1-x0,y1-y0,z1-z0,align=M)

base = bx(0,0,0,base_w,base_d,base_t)
for sx in (12, base_w-12):
    for sy in (12, base_d-12):
        base = base - Pos(sx,sy,base_t/2)*Cylinder(2.5, base_t+2)

fy = 15
back = Box(80,6,110,align=M)
back = Rot(-(90-lean_deg_from_base),0,0)*back
back = Pos(5,fy,base_t)*back
lip = bx(5,fy-6,base_t,85,fy,base_t+12)
cradle = back+lip
cradle = cradle - bx(40,0,base_t,50,50,base_t+15)

inner = tablet_t+2*tablet_gap
cx = 135; wt = 4
walls = bx(cx-inner/2-wt,8,base_t,cx-inner/2,78,base_t+60) + bx(cx+inner/2,8,base_t,cx+inner/2+wt,78,base_t+60)

bw=160; bd=40; wall=3; div=2
bx0=(base_w-bw)/2; by0=base_d-bd; bz1=base_t+box_h
box = bx(bx0,by0,base_t,bx0+bw,by0+bd,bz1) - bx(bx0+wall,by0+wall,base_t+3,bx0+bw-wall,by0+bd-wall,bz1+1)
cw = (bw-2*wall-(comp_count-1)*div)/comp_count
for i in range(1,comp_count):
    x = bx0+wall+i*cw+(i-1)*div
    box = box + bx(x,by0+wall,base_t,x+div,by0+bd-wall,bz1)

ay = base_d+4; az = bz1+2
box_k=[(bx0+2,bx0+10),(bx0+bw-10,bx0+bw-2)]
lid_k=[(bx0+10,bx0+18),(bx0+bw-18,bx0+bw-10)]
def kn(x0,x1): return Pos(x0,ay,az)*Rot(0,90,0)*Cylinder(3.5,x1-x0,align=(Align.CENTER,Align.CENTER,Align.MIN))
def hole(): return Pos(0,ay,az)*Rot(0,90,0)*Cylinder(2.15,base_w,align=(Align.CENTER,Align.CENTER,Align.MIN))
dock = base+cradle+walls+box
for a,b in box_k:
    dock = dock + kn(a,b) + bx(a,base_d-1,bz1-5,b,ay,bz1)
dock = dock - hole()
lid = bx(bx0,by0,bz1,bx0+bw,by0+bd,bz1+4)
for a,b in lid_k:
    lid = lid + kn(a,b) + bx(a,by0+bd-2,bz1,b,ay,bz1+4)
lid = lid - hole()
if lid_open_deg:
    lid = Pos(0,ay,az)*Rot(-lid_open_deg,0,0)*Pos(0,-ay,-az)*lid
pins=[]
for (a,b),(c,d) in zip(box_k,lid_k):
    lo=min(a,c); hi=max(b,d)
    pins.append(Pos(lo,ay,az)*Rot(0,90,0)*Cylinder(2,hi-lo,align=(Align.CENTER,Align.CENTER,Align.MIN)))
dock.label="dock_body"; lid.label="lid"
for p in pins: p.label="pin"
_cadai_parts=[dock,lid]+pins
result=Compound(_cadai_parts)