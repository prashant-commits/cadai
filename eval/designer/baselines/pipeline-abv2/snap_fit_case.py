from build123d import *
box_l=80;box_w=50;box_h=30;wall_t=2;lid_h=6;hook_w=8;hook_len=5;hook_x=15;barb=0.8;arm_t=1.2;barb_h=2.5
base_h=box_h-lid_h
hook_z=base_h-hook_len
hx2=box_l-hook_x-hook_w
def hk():
    return extrude(Plane.YZ*Polygon((barb,0),(barb+arm_t,0),(barb+arm_t,hook_len),(barb,hook_len),(barb,barb_h),(0,barb_h),(0,barb_h-1),align=None),amount=hook_w)
# arm sits in wall region; shift so hook inner face lies against wall inside
yf=wall_t
b=Box(box_l,box_w,base_h,align=(Align.MIN,)*3)-Pos(wall_t,wall_t,wall_t)*Box(box_l-2*wall_t,box_w-2*wall_t,base_h,align=(Align.MIN,)*3)
b=b.fillet(2,b.edges().filter_by(Axis.Z)) if False else b
lid=Pos(0,0,base_h)*Box(box_l,box_w,lid_h,align=(Align.MIN,)*3)
def f(x):return Pos(x,yf,hook_z)*hk()
def r(x):return Pos(x+hook_w,box_w-yf,hook_z)*Rot(0,0,180)*hk()
hs=[f(hook_x),f(hx2),r(hook_x),r(hx2)]
names=["hook_front_a","hook_front_b","hook_rear_a","hook_rear_b"]
b.label="base";lid.label="lid"
for h,n in zip(hs,names):h.label=n
_cadai_parts=[b,lid]+hs
result=Compound(_cadai_parts)