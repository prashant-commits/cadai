L = 160  # [100:5:250] length
W = 120  # [80:5:200] width
H = 90  # [50:5:150] body height
wall = 3  # [2:0.5:5] wall
lip_h = 5  # [3:1:10] lip height
skirt = 1.5  # [1:0.5:2] outer skirt thickness at crate bottom
fit = 0.2  # [0.1:0.1:0.5] clearance
slot_h = 14  # [8:1:30] slot height
slot_z = 40  # [20:5:60] slot bottom
def rb(x,y,z,r):
    return extrude(Plane.XY*RectangleRounded(x,y,r),amount=z)
body = rb(L,W,H,6) - Pos(0,0,lip_h+wall)*rb(L-2*wall,W-2*wall,H,3)
body = body - Pos(0,0,-1)*rb(L-2*skirt,W-2*skirt,lip_h+1,5)
body = body + Pos(0,0,lip_h)*rb(L-2*skirt,W-2*skirt,wall,5)
body = body - Pos(0,0,lip_h+wall)*rb(L-2*wall,W-2*wall,H,3)
lo=skirt+fit
lip = Pos(0,0,H)*(rb(L-2*lo,W-2*lo,lip_h,5)-Pos(0,0,-1)*rb(L-2*wall,W-2*wall,lip_h+2,3))
cs=[]
for i in range(6):
    x=(i-2.5)*24; cs.append(Pos(x,0,slot_z+slot_h/2)*Box(16,W+4,slot_h))
    y=(i-2.5)*17; cs.append(Pos(0,y,slot_z+slot_h/2)*Box(L+4,12,slot_h))
body = body - Compound(cs)
body.label="crate"; lip.label="lip"
_cadai_parts=[body,lip]
result=body+lip