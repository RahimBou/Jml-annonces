(()=>{"use strict";
const $=id=>document.getElementById(id),canvas=$("designCanvas"),ctx=canvas.getContext("2d");
const sizes={square:[1080,1080],portrait:[1080,1350],story:[1080,1920],landscape:[1200,630]};
let pages=[{background:"#f6f2e9",objects:[]}],pageIndex=0,selectedId=null,drag=null,projectName="Ma création JML",db=null;
const uid=()=>Math.random().toString(36).slice(2,10);
const page=()=>pages[pageIndex],selected=()=>page().objects.find(o=>o.id===selectedId);
function status(t){$("status").textContent=t}
function fitCanvas(){const [w,h]=sizes[$("format").value];canvas.width=w;canvas.height=h;draw()}
function draw(){ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle=page().background||"#f6f2e9";ctx.fillRect(0,0,canvas.width,canvas.height);
for(const o of page().objects){ctx.save();ctx.globalAlpha=o.opacity??1;
if(o.type==="text"){ctx.fillStyle=o.color||"#17382f";ctx.font=(o.weight||"700")+" "+(o.fontSize||56)+"px "+(o.font||"Arial");ctx.textBaseline="top";wrapText(o.text||"",o.x,o.y,o.width||700,(o.fontSize||56)*1.2)}
if(o.type==="rect"){ctx.fillStyle=o.color||"#c6a15b";ctx.fillRect(o.x,o.y,o.width,o.height)}
if(o.type==="image"&&o.data){const im=new Image();im.onload=()=>{ctx.save();ctx.globalAlpha=o.opacity??1;ctx.drawImage(im,o.x,o.y,o.width,o.height);ctx.restore();if(selectedId===o.id)drawSelection(o)};im.src=o.data}
ctx.restore();if(selectedId===o.id&&o.type!=="image")drawSelection(o)}
}
function wrapText(text,x,y,maxWidth,lineHeight){const words=String(text).split(/\s+/);let line="",yy=y;for(const word of words){const test=line?line+" "+word:word;if(ctx.measureText(test).width>maxWidth&&line){ctx.fillText(line,x,yy);line=word;yy+=lineHeight}else line=test}if(line)ctx.fillText(line,x,yy)}
function bounds(o){return {x:o.x,y:o.y,w:o.width||400,h:o.height||(o.fontSize||56)*1.3}}
function drawSelection(o){const b=bounds(o);ctx.save();ctx.strokeStyle="#c6a15b";ctx.lineWidth=Math.max(3,canvas.width/360);ctx.setLineDash([10,7]);ctx.strokeRect(b.x,b.y,b.w,b.h);ctx.setLineDash([]);ctx.fillStyle="#c6a15b";ctx.fillRect(b.x+b.w-18,b.y+b.h-18,36,36);ctx.restore()}
function select(id){selectedId=id;const o=selected();$("emptySelection").hidden=!!o;$("objectProperties").hidden=!o;if(o){$("objectText").value=o.type==="text"?o.text:"";$("objectText").parentElement.hidden=o.type!=="text";$("objectColor").value=hex(o.color||"#17382f");$("objectFontSize").value=o.fontSize||56;$("fontSizeValue").value=(o.fontSize||56)+" px";$("objectFont").value=o.font||"Arial";$("objectOpacity").value=Math.round((o.opacity??1)*100);$("objectWidth").value=Math.min(1080,o.width||400);$("objectHeight").value=Math.min(1920,o.height||160)}draw()}
function hex(v){return /^#[0-9a-f]{6}$/i.test(v)?v:"#17382f"}
function pointer(e){const r=canvas.getBoundingClientRect();return {x:(e.clientX-r.left)*canvas.width/r.width,y:(e.clientY-r.top)*canvas.height/r.height}}
function hit(p,o){const b=bounds(o);return p.x>=b.x&&p.x<=b.x+b.w&&p.y>=b.y&&p.y<=b.y+b.h}
canvas.addEventListener("pointerdown",e=>{const p=pointer(e),objs=page().objects;let found=null;for(let i=objs.length-1;i>=0;i--)if(hit(p,objs[i])){found=objs[i];break}select(found?.id||null);if(found){drag={id:found.id,start:p,x:found.x,y:found.y,resize:p.x>bounds(found).x+bounds(found).w-28&&p.y>bounds(found).y+bounds(found).h-28};canvas.setPointerCapture(e.pointerId)}});
canvas.addEventListener("pointermove",e=>{if(!drag)return;const p=pointer(e),o=page().objects.find(x=>x.id===drag.id);if(!o)return;const dx=p.x-drag.start.x,dy=p.y-drag.start.y;if(drag.resize){o.width=Math.max(40,Math.min(canvas.width-drag.x, (o.width||400)+dx));o.height=Math.max(30,Math.min(canvas.height-drag.y,(o.height||140)+dy));drag.start=p}else{o.x=Math.max(0,Math.min(canvas.width-20,drag.x+dx));o.y=Math.max(0,Math.min(canvas.height-20,drag.y+dy))}draw()});
canvas.addEventListener("pointerup",()=>drag=null);canvas.addEventListener("pointercancel",()=>drag=null);
function addText(text="Votre texte ici"){const o={id:uid(),type:"text",text,x:90,y:150,width:850,height:180,fontSize:64,font:"Georgia",weight:"700",color:"#17382f",opacity:1};page().objects.push(o);select(o.id)}
function addRect(){const o={id:uid(),type:"rect",x:100,y:100,width:500,height:180,color:"#c6a15b",opacity:.9};page().objects.push(o);select(o.id)}
$("addText").onclick=()=>addText();$("addRect").onclick=addRect;
$("deleteObject").onclick=()=>{if(!selected())return;page().objects=page().objects.filter(o=>o.id!==selectedId);select(null)};
$("bringFront").onclick=()=>{const o=selected();if(!o)return;page().objects=page().objects.filter(x=>x.id!==o.id);page().objects.push(o);draw()};
$("objectText").oninput=e=>{if(selected()?.type==="text"){selected().text=e.target.value;draw()}};
$("objectColor").oninput=e=>{if(selected()){selected().color=e.target.value;draw()}};
$("objectFontSize").oninput=e=>{if(selected()){selected().fontSize=+e.target.value;$("fontSizeValue").value=e.target.value+" px";draw()}};
$("objectFont").onchange=e=>{if(selected()){selected().font=e.target.value;draw()}};
$("objectOpacity").oninput=e=>{if(selected()){selected().opacity=+e.target.value/100;draw()}};
$("objectWidth").oninput=e=>{if(selected()){selected().width=+e.target.value;draw()}};
$("objectHeight").oninput=e=>{if(selected()){selected().height=+e.target.value;draw()}};
$("format").onchange=()=>{fitCanvas();status("Format modifié. Les éléments restent sur la page.")};
function fileData(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file)})}
$("imageFiles").onchange=async e=>{for(const f of [...e.target.files]){if(!f.type.startsWith("image/"))continue;const data=await fileData(f),im=new Image();await new Promise((res,rej)=>{im.onload=res;im.onerror=rej;im.src=data});const scale=Math.min(760/im.width,760/im.height,1),w=im.width*scale,h=im.height*scale,o={id:uid(),type:"image",data,name:f.name,x:(canvas.width-w)/2,y:(canvas.height-h)/2,width:w,height:h,opacity:1};page().objects.push(o);select(o.id)}e.target.value="";status("Photo(s) ajoutée(s).")};
function renderTemplates(){$("templates").innerHTML="";(window.JML_TEMPLATES||[]).forEach(t=>{const b=document.createElement("button");b.className="template-card";b.innerHTML='<div class="template-swatch" style="background:'+t.bg+';color:'+t.accent+'">JML</div><strong>'+t.name+'</strong>';b.onclick=()=>applyTemplate(t);$("templates").append(b)})}
function applyTemplate(t){page().background=t.bg;page().objects=[{id:uid(),type:"text",text:t.title,x:70,y:canvas.height*.24,width:canvas.width-140,height:canvas.height*.18,fontSize:Math.round(canvas.width*.055),font:"Georgia",color:t.accent,weight:"700",opacity:1},{id:uid(),type:"text",text:t.subtitle,x:75,y:canvas.height*.43,width:canvas.width-150,height:canvas.height*.14,fontSize:Math.round(canvas.width*.027),font:"Arial",color:t.layout==="editorial"?"#17382f":"#f6f2e9",weight:"600",opacity:1}];if(t.layout==="property")page().objects.push({id:uid(),type:"rect",x:70,y:canvas.height*.66,width:canvas.width-140,height:canvas.height*.2,color:t.accent,opacity:.95});select(null);draw();status("Modèle « "+t.name+" » appliqué. Ajoute tes photos et adapte les textes.") }
function renderPages(){$("pages").innerHTML="";pages.forEach((p,i)=>{const b=document.createElement("button");b.className="page-chip"+(i===pageIndex?" active":"");b.textContent="Page "+(i+1);b.onclick=()=>{pageIndex=i;select(null);renderPages();draw();$("pageLabel").textContent="Page "+(i+1)+" / "+pages.length};$("pages").append(b)});$("pageLabel").textContent="Page "+(pageIndex+1)+" / "+pages.length}
$("addPage").onclick=()=>{pages.push({background:"#f6f2e9",objects:[]});pageIndex=pages.length-1;select(null);renderPages();draw()};
function openDB(){return new Promise((resolve,reject)=>{const req=indexedDB.open("jml-studio",1);req.onupgradeneeded=()=>req.result.createObjectStore("projects",{keyPath:"id"});req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
async function refreshProjects(){if(!db)return;const tx=db.transaction("projects","readonly"),req=tx.objectStore("projects").getAll();req.onsuccess=()=>{$("projectList").innerHTML='<option value="">Choisir un projet…</option>';req.result.forEach(p=>{const o=document.createElement("option");o.value=p.id;o.textContent=p.name;$("projectList").append(o)})}}
async function saveProject(){try{if(!db)db=await openDB();const id=window.currentJmlProjectId||uid();window.currentJmlProjectId=id;const data={id,name:projectName,format:$("format").value,pages:JSON.parse(JSON.stringify(pages)),updatedAt:new Date().toISOString()};await new Promise((resolve,reject)=>{const tx=db.transaction("projects","readwrite");tx.objectStore("projects").put(data);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});await refreshProjects();$("projectList").value=id;status("Projet enregistré dans ce navigateur : "+projectName)}catch(e){status("Enregistrement impossible : "+e.message)}}
async function loadProject(){try{if(!db)db=await openDB();const id=$("projectList").value;if(!id)return status("Choisis un projet.");const data=await new Promise((resolve,reject)=>{const r=db.transaction("projects").objectStore("projects").get(id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});if(!data)return;projectName=data.name;pages=data.pages;pageIndex=0;$("format").value=data.format;fitCanvas();renderPages();select(null);draw();status("Projet ouvert : "+projectName)}catch(e){status("Ouverture impossible : "+e.message)}}
$("saveProject").onclick=saveProject;$("loadProject").onclick=loadProject;
$("newProject").onclick=()=>{if(!confirm("Créer un nouveau projet ? Les modifications non enregistrées seront perdues."))return;pages=[{background:"#f6f2e9",objects:[]}];pageIndex=0;window.currentJmlProjectId=null;projectName="Ma création JML";renderPages();select(null);draw();status("Nouveau projet.")};
async function exportOne(){const a=document.createElement("a");a.download="JML-Studio-page-"+(pageIndex+1)+".png";a.href=canvas.toDataURL("image/png");a.click()}
$("exportPage").onclick=exportOne;
$("exportPage").addEventListener("contextmenu",e=>e.preventDefault());
async function exportAll(){if(!window.JSZip){for(let i=0;i<pages.length;i++){pageIndex=i;draw();await new Promise(r=>setTimeout(r,100));await exportOne()}return}const zip=new JSZip(),original=pageIndex;for(let i=0;i<pages.length;i++){pageIndex=i;draw();await new Promise(r=>setTimeout(r,80));zip.file("page-"+(i+1)+".png",canvas.toDataURL("image/png").split(",")[1],{base64:true})}pageIndex=original;draw();const blob=await zip.generateAsync({type:"blob"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="JML-Studio-carrousel.zip";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),30000)}
$("exportPage").ondblclick=exportAll;
renderTemplates();fitCanvas();renderPages();openDB().then(async d=>{db=d;await refreshProjects()}).catch(()=>status("Sauvegarde locale indisponible dans ce navigateur."));
})();