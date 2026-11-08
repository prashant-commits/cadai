from build123d import *
shell_w=150
shell_d=120
shell_h=80
wall=3
clearance=0.5
rail_w=6
rail_h=4
rail_z=10
drawer_h=60
handle_out=16
handle_d=8
post_d=6
post_span=50
drawer_travel=0  # [0:5:80] drawer pull-out distance
drawer_w=shell_w-2*wall-2*clearance
drawer_d=shell_d-wall-2
zc=rail_z+rail_h+drawer_h/2
B=(Align.MIN,Align.MIN,Align.MIN)
sh=Box(shell_w,shell_d,shell_h,align=B)-Pos(wall,-0.02,wall)*Box(shell_w-2*wall,shell_d-wall+0.02,shell_h-2*wall,align=B)
sh=Pos(0,handle_out,0)*sh
rl=Pos(wall,handle_out,rail_z)*Box(rail_w,shell_d-wall,rail_h,align=B)
rr=Pos(shell_w-wall-rail_w,handle_out,rail_z)*Box(rail_w,shell_d-wall,rail_h,align=B)
dr=Box(drawer_w,drawer_d,drawer_h,align=B)-Pos(wall,wall,wall)*Box(drawer_w-2*wall,drawer_d-2*wall,drawer_h,align=B)
dr=Pos(wall+clearance,handle_out-drawer_travel,rail_z+rail_h)*dr
def post(x):
    return Pos(x,handle_out-drawer_travel+1,zc)*Rot(90,0,0)*Cylinder(post_d/2,handle_out+1,align=(Align.CENTER,Align.CENTER,Align.MIN))
pl=post(shell_w/2-post_span/2)
pr=post(shell_w/2+post_span/2)
hb=Pos(shell_w/2-post_span/2-post_d/2,handle_d/2-drawer_travel,zc)*Rot(0,90,0)*Cylinder(handle_d/2,post_span+post_d,align=(Align.CENTER,Align.CENTER,Align.MIN))
_cadai_parts=[sh,rl,rr,dr,pl,pr,hb]
for p,n in zip(_cadai_parts,["outer_shell","rail_left","rail_right","drawer","handle_post_left","handle_post_right","handle_bar"]):p.label=n
frame=sh+rl+rr
handle=dr+pl+pr+hb
result=Compound([frame,handle])