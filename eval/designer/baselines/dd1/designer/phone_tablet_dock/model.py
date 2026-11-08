base_w=180  # [100:5:250] base width
base_d=120  # [100:5:200] base depth
base_t=8  # [4:1:15] base thickness
lean_deg=70  # [70:1:85] backrest lean from base plane
tablet_t=12  # [12:1:20] tablet thickness
tablet_gap=1  # [1:0.5:4] clearance each side of tablet
box_h=30  # [30:1:50] storage box height
comp_count=4  # [4:1:8] compartments
lid_open_deg=0  # [0:5:110] lid opening angle
bw=80; bh=110; bt=6; lip_h=12; foot_y=20; foot_x=10
wall=3; div=2; box_w=160; box_d=40; box_y=80; box_x=10
lid_t=4; pin_d=4; clr=0.3; kr=4
A=(Align.MIN,Align.MIN,Align.MIN)
def bx(x,y,z,dx,dy,dz): return Pos(x,y,z)*Box(dx,dy,dz,align=A)
def cx(x0,x1,r,y,z): return Pos((x0+x1)/2,y,z)*Cylinder(r,x1-x0,rotation=(0,90,0))
base=bx(0,0,0,base_w,base_d,base_t)
for sx in (12,base_w-12):
    for sy in (12,base_d-12):
        base=base-Pos(sx,sy,0)*Cylinder(2.5,3*base_t)
back=Pos(foot_x,foot_y,base_t)*Rot(-(90-lean_deg),0,0)*bx(0,0,0,bw,bt,bh)
lip=bx(foot_x,foot_y-bt,base_t,bw,bt+3,lip_h)
cradle=back+lip
cradle=cradle-bx(foot_x+bw/2-5,0,base_t,10,60,15)
inner=tablet_t+2*tablet_gap
ty=50
tw1=bx(100,ty-inner/2-6,base_t,70,6,60)
tw2=bx(100,ty+inner/2,base_t,70,6,60)
box=bx(box_x,box_y,base_t,box_w,box_d,box_h)-bx(box_x+wall,box_y+wall,base_t+1,box_w-2*wall,box_d-2*wall,box_h)
iw=box_w-2*wall
cw=(iw-(comp_count-1)*div)/comp_count
for i in range(1,comp_count):
    box=box+bx(box_x+wall+i*cw+(i-1)*div,box_y+wall,base_t,div,box_d-2*wall,box_h)
ay=box_y+box_d+kr; az=base_t+box_h+lid_t/2
def kn(x0,x1,low):
    k=cx(x0,x1,kr,ay,az)
    k=k+(bx(x0,box_y+box_d,az-8,x1-x0,kr,8) if low else bx(x0,box_y+box_d,az-lid_t/2,x1-x0,kr,lid_t))
    return k-cx(x0-1,x1+1,pin_d/2+clr,ay,az)
bk=[kn(a,b,True) for a,b in ((12,30),(150,168))]
body=base+cradle+tw1+tw2+box+bk[0]+bk[1]
lid=bx(box_x,box_y,base_t+box_h,box_w,box_d,lid_t)
for a,b in ((32,48),(132,148)):
    lid=lid+kn(a,b,False)
lid=Pos(0,ay,az)*Rot(-lid_open_deg,0,0)*Pos(0,-ay,-az)*lid
pins=[]
for a,b in ((12,48),(132,168)):
    p=cx(a,b,pin_d/2,ay,az)
    p.label="pin"; pins.append(p)
body.label="dock_body"; lid.label="lid"
_cadai_parts=[body,lid]+pins
result=Compound(_cadai_parts)