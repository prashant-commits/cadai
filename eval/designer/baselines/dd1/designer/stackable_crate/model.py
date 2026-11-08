L = 160  # [100:5:250] length
W = 120  # [80:5:200] width
H = 90  # [50:5:150] body height
t = 3  # [2:0.5:6] wall
lip_h = 6  # [3:1:10] lip height
clr = 0.4  # [0.2:0.1:1] lip clearance
slot_w = 14  # [6:1:20] slot width
slot_h = 8  # [3:1:12] slot height
slot_z = 40  # [20:5:60] slot bottom height

outer = _round(Pos(0,0,H/2)*Box(L,W,H), 4, edges="vertical")
cav = Pos(0,0,lip_h+(H-lip_h)/2+0.01)*Box(L-2*t,W-2*t,H-lip_h)
under = Pos(0,0,lip_h/2-0.01)*Box(L-2*t,W-2*t,lip_h+0.02)
body = outer - cav - under
floor = Pos(0,0,lip_h+t/2)*Box(L-2*t+1,W-2*t+1,t)
body = body + (floor & outer)
for i in range(6):
    body = body - Pos((i-2.5)*20,0,slot_z)*Box(slot_w,W+2,slot_h)
    body = body - Pos(0,(i-2.5)*17,slot_z)*Box(L+2,slot_w*0.8,slot_h)
lo = Pos(0,0,H+lip_h/2)*Box(L-2*t-2*clr,W-2*t-2*clr,lip_h)
li = Pos(0,0,H+lip_h/2)*Box(L-4*t-2*clr,W-4*t-2*clr,lip_h+1)
lip = lo-li
body.label="crate"; lip.label="lip"
_cadai_parts=[body,lip]
result = body+lip