def _sind(d): return sin(radians(d))
def _cosd(d): return cos(radians(d))
lean_deg = 70  # [55:1:85] Backrest lean from base plane
tablet_gap = 14  # [8:0.5:30] Inner gap between tablet walls
box_h = 30  # [15:1:50] Storage box height
compartments = 4  # [2:1:4] Box compartments
base_t = 8  # [4:1:12] Base thickness
back_t = 6  # [3:1:10] Backrest and lip thickness
back_len = 110  # [60:1:130] Backrest length along slope
slot_len = 15  # [5:1:30] Cable slot depth along slope
box_wall = 3  # [2:0.5:5] Box wall thickness
tab_wall = 4  # [2:0.5:8] Tablet wall thickness
lid_open_deg = 0  # [0:5:110] Lid opening angle
bw=back_t/_sind(lean_deg); bdx=back_len*_cosd(lean_deg); bh=back_len*_sind(lean_deg)
bdx2=(back_len-slot_len)*_cosd(lean_deg); bh2=(back_len-slot_len)*_sind(lean_deg)
inner_w=160-2*box_wall
comp_w=(inner_w-2*(compartments-1))/compartments
top_z=base_t+box_h
M=(Align.MIN,)*3
def B(x,y,z,px,py,pz): return Pos(px,py,pz)*Box(x,y,z,align=M)
plate=B(180,120,base_t,0,0,0)
for hx,hy in [(12,12),(168,12),(12,108),(168,108)]:
    plate=plate-Pos(hx,hy,-0.02)*Cylinder(2.5,base_t+0.04,align=(Align.CENTER,Align.CENTER,Align.MIN))
lip_a=B(35,back_t,12,15,9,base_t-0.02)
lip_b=B(35,back_t,12,60,9,base_t-0.02)
prof=lambda a,b:[(0,0),(bw,0),(bw+a,b),(a,b)]
br_a=Pos(15,14.98,base_t-0.02)*extrude(Plane.YZ*Polygon(*prof(bdx,bh),align=None),amount=35)
br_b=Pos(60,14.98,base_t-0.02)*extrude(Plane.YZ*Polygon(*prof(bdx,bh),align=None),amount=35)
br_u=Pos(50,15+slot_len*_cosd(lean_deg),base_t+slot_len*_sind(lean_deg))*extrude(Plane.YZ*Polygon(*prof(bdx2,bh2),align=None),amount=10)
twa=B(70,tab_wall,60,100,40-tablet_gap/2-tab_wall,base_t-0.02)
twb=B(70,tab_wall,60,100,40+tablet_gap/2,base_t-0.02)
sb=B(160,40,box_h,10,80,base_t-0.02)-B(160-2*box_wall,40-2*box_wall,box_h-box_wall+0.02,10+box_wall,80+box_wall,base_t+box_wall)
divs=[B(2,40-2*box_wall,box_h-box_wall,10+box_wall+min(i,compartments-1)*comp_w+(min(i,compartments-1)-1)*2,80+box_wall,base_t+box_wall) for i in (1,2,3)]
kna=B(10,6,8,15,119.98,top_z-2); knb=B(10,6,8,135,119.98,top_z-2)
def pin(x): return Pos(x,121,top_z)*Pos(0,2,2)*Rot(0,90,0)*Cylinder(2,20,align=(Align.CENTER,Align.CENTER,Align.MIN))
pa=pin(15); pb=pin(135)
def rot(s): return Pos(0,123,top_z+2)*Rot(-lid_open_deg,0,0)*Pos(0,-123,-(top_z+2))*s
lid=B(160,40,4,10,80,top_z-0.04)
def cav(k,x): return k-Pos(x,121,top_z)*Pos(-0.15,2,2)*Rot(0,90,0)*Cylinder(2.15,20.3,align=(Align.CENTER,Align.CENTER,Align.MIN))
lka=cav(B(9.7,6,8,25.3,119.98,top_z-2),15); lkb=cav(B(9.7,6,8,145.3,119.98,top_z-2),135)
lid=rot(lid); lka=rot(lka); lkb=rot(lkb)
names=["base_plate","lip_a","lip_b","backrest_a","backrest_b","backrest_upper","tablet_wall_a","tablet_wall_b","storage_box","divider_1","divider_2","divider_3","box_knuckle_a","box_knuckle_b","hinge_pin_a","hinge_pin_b","lid_panel","lid_knuckle_a","lid_knuckle_b"]
shapes=[plate,lip_a,lip_b,br_a,br_b,br_u,twa,twb,sb]+divs+[kna,knb,pa,pb,lid,lka,lkb]
for n,s in zip(names,shapes): s.label=n
_cadai_parts=shapes
fixed=plate+lip_a+lip_b+br_a+br_b+br_u+twa+twb+sb+divs[0]+divs[1]+divs[2]+kna+knb
lidf=lid+lka+lkb
result=Compound([fixed,lidf,pa,pb])