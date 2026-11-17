(()=>{"use strict";
const $=id=>document.getElementById(id);
const canvas=$("designCanvas"),ctx=canvas.getContext("2d");
const sizes={square:[1080,1080],portrait:[1080,1350],story:[1080,1920],landscape:[1200,630]};
let pages=[{background:"#f6f2e9",objects:[]}],pageIndex=0,selectedId=null,drag=null,projectName="Ma création JML",db=null;
const imageCache=new Map();
const uid=()=>crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2)+Date.now().toString(36);
const page=()=>pages[pageIndex],selected=()=>page().objects.find(o=>o.id===selectedId);
function status(message){$("status").textContent=message}
function hex(value){return /^#[0-9a-f]{6}$/i.test(value)?value:"#17382f"}
function getImage(data){if(imageCache.has(data)){const cached=imageCache.get(data);if(cached.complete&&cached.naturalWidth)return Promise.resolve(cached);return new Promise((resolve,reject)=>{cached.addEventListener("load",()=>resolve(cached),{once:true});cached.addEventListener("error",()=>reject(new Error("Une image n'a pas pu être chargée.")),{once:true})})}const image=new Image();imageCache.set(data,image);const promise=new Promise((resolve,reject)=>{image.onload=()=>{draw();resolve(image)};image.onerror=()=>reject(new Error("Une image n'a pas pu être chargée."));image.src=data});return promise}
function wrapText(context,text,x,y,maxWidth,lineHeight){const words=String(text).split(/\s+/);let line="",yy=y;for(const word of words){const test=line?line+" "+word:word;if(context.measureText(test).width>maxWidth&&line){context.fillText(line,x,yy);line=word;yy+=lineHeight}else line=test}if(line)context.fillText(line,x,yy)}
function bounds(object){return{x:object.x,y:object.y,w:object.width||400,h:object.height||(object.fontSize||56)*1.3}}
function drawSelection(object,context=ctx){const b=bounds(object);context.save();context.strokeStyle="#c6a15b";context.lineWidth=Math.max(3,canvas.width/360);context.setLineDash([10,7]);context.strokeRect(b.x,b.y,b.w,b.h);context.setLineDash([]);context.fillStyle="#c6a15b";context.fillRect(b.x+b.w-18,b.y+b.h-18,36,36);context.restore()}
function drawObject(object,context){context.save();context.globalAlpha=object.opacity??1;if(object.type==="text"){context.fillStyle=object.color||"#17382f";context.font=(object.weight||"700")+" "+(object.fontSize||56)+"px "+(object.font||"Arial");context.textBaseline="top";wrapText(context,object.text||"",object.x,object.y,object.width||700,(object.fontSize||56)*1.2)}else if(object.type==="rect"){context.fillStyle=object.color||"#c6a15b";context.fillRect(object.x,object.y,object.width,object.height)}else if(object.type==="image"){const image=imageCache.get(object.data);if(image&&image.complete&&image.naturalWidth)context.drawImage(image,object.x,object.y,object.width,object.height)}context.restore()}
function draw(){ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle=page().background||"#f6f2e9";ctx.fillRect(0,0,canvas.width,canvas.height);for(const object of page().objects){drawObject(object,ctx);if(object.id===selectedId)drawSelection(object)}}
function fitCanvas(){const [width,height]=sizes[$("format").value];canvas.width=width;canvas.height=height;draw()}
function select(id){selectedId=id;const object=selected();$("emptySelection").hidden=!!object;$("objectProperties").hidden=!object;if(object){$("textField").hidden=object.type!=="text";$("objectText").value=object.type==="text"?object.text:"";$("objectColor").value=hex(object.color);$("objectFontSize").value=object.fontSize||56;$("fontSizeValue").value=(object.fontSize||56)+" px";$("objectFont").value=object.font||"Arial";$("objectOpacity").value=Math.round((object.opacity??1)*100);$("objectWidth").value=Math.min(1200,object.width||400);$("objectHeight").value=Math.min(1920,object.height||160)}draw()}
function pointer(event){const rect=canvas.getBoundingClientRect();return{x:(event.clientX-rect.left)*canvas.width/rect.width,y:(event.clientY-rect.top)*canvas.height/rect.height}}
function hit(point,object){const b=bounds(object);return point.x>=b.x&&point.x<=b.x+b.w&&point.y>=b.y&&point.y<=b.y+b.h}
canvas.addEventListener("pointerdown",event=>{const point=pointer(event),objects=page().objects;let found=null;for(let i=objects.length-1;i>=0;i--)if(hit(point,objects[i])){found=objects[i];break}select(found?.id||null);if(found){const b=bounds(found);drag={id:found.id,start:point,x:found.x,y:found.y,resize:point.x>b.x+b.w-28&&point.y>b.y+b.h-28};canvas.setPointerCapture(event.pointerId)}});
canvas.addEventListener("pointermove",event=>{if(!drag)return;const point=pointer(event),object=page().objects.find(item=>item.id===drag.id);if(!object)return;const dx=point.x-drag.start.x,dy=point.y-drag.start.y;if(drag.resize){object.width=Math.max(40,Math.min(canvas.width-object.x,(object.width||400)+dx));object.height=Math.max(30,Math.min(canvas.height-object.y,(object.height||140)+dy));drag.start=point}else{object.x=Math.max(0,Math.min(canvas.width-20,drag.x+dx));object.y=Math.max(0,Math.min(canvas.height-20,drag.y+dy))}draw()});
canvas.addEventListener("pointerup",()=>drag=null);canvas.addEventListener("pointercancel",()=>drag=null);
function addText(text="Votre texte ici"){const object={id:uid(),type:"text",text,x:90,y:150,width:850,height:180,fontSize:64,font:"Georgia",weight:"700",color:"#17382f",opacity:1};page().objects.push(object);select(object.id)}
function addRect(){const object={id:uid(),type:"rect",x:100,y:100,width:500,height:180,color:"#c6a15b",opacity:.9};page().objects.push(object);select(object.id)}
$("addText").onclick=()=>addText();$("addRect").onclick=addRect;
$("deleteObject").onclick=()=>{if(!selected())return;page().objects=page().objects.filter(object=>object.id!==selectedId);select(null)};
$("bringFront").onclick=()=>{const object=selected();if(!object)return;page().objects=page().objects.filter(item=>item.id!==object.id);page().objects.push(object);draw()};
$("objectText").oninput=event=>{if(selected()?.type==="text"){selected().text=event.target.value;draw()}};
$("objectColor").oninput=event=>{if(selected()){selected().color=event.target.value;draw()}};
$("objectFontSize").oninput=event=>{if(selected()){selected().fontSize=+event.target.value;$("fontSizeValue").value=event.target.value+" px";draw()}};
$("objectFont").onchange=event=>{if(selected()){selected().font=event.target.value;draw()}};
$("objectOpacity").oninput=event=>{if(selected()){selected().opacity=+event.target.value/100;draw()}};
$("objectWidth").oninput=event=>{if(selected()){selected().width=+event.target.value;draw()}};
$("objectHeight").oninput=event=>{if(selected()){selected().height=+event.target.value;draw()}};
$("format").onchange=()=>{fitCanvas();status("Format modifié. Les éléments restent sur la page.")};
function fileData(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file)})}
$("imageFiles").onchange=async event=>{try{for(const file of [...event.target.files]){if(!file.type.startsWith("image/"))continue;const data=await fileData(file),image=await getImage(data),scale=Math.min(760/image.width,760/image.height,1),width=image.width*scale,height=image.height*scale,object={id:uid(),type:"image",data,name:file.name,x:(canvas.width-width)/2,y:(canvas.height-height)/2,width,height,opacity:1};page().objects.push(object);select(object.id)}status("Photo(s) ajoutée(s). Les images sont chargées avant l'export.")}catch(error){status("Import photo impossible : "+error.message)}finally{event.target.value=""}};
async function importListing(){
 const input=$("listingUrl"),button=$("importListing"),summary=$("importSummary"),url=String(input.value||"").trim();
 if(!url){status("Colle d’abord le lien d’une annonce JML Immobilier.");input.focus();return}
 button.disabled=true;button.textContent="Récupération…";summary.hidden=true;
 try{
  const response=await fetch("/api/import-annonce",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url})});
  const result=await response.json();
  if(!response.ok||!result.ok)throw new Error(result.error||"Import de l’annonce impossible.");
  const listing=result.listing,photos=result.photos||[];
  if(!photos.length)throw new Error("Les informations ont été lues, mais aucune photo originale n’a pu être récupérée. Vérifie la galerie de l’annonce.");
  const loaded=[];
  for(const photo of photos){const image=await getImage(photo.data);loaded.push({data:photo.data,name:photo.name,width:image.naturalWidth,height:image.naturalHeight})}
  const facts=[listing.surface,listing.terrain,listing.rooms?listing.rooms+" pièces":null,listing.bedrooms?listing.bedrooms+" chambres":null].filter(Boolean).join(" · ");
  const title=listing.title||"Bien immobilier à découvrir";
  pages=loaded.map((photo,index)=>{
   const [w,h]=sizes.portrait;
   const maxW=w-100,maxH=700,scale=Math.min(maxW/photo.width,maxH/photo.height);
   const iw=Math.round(photo.width*scale),ih=Math.round(photo.height*scale);
   const x=Math.round((w-iw)/2),y=110;
   const objects=[
    {id:uid(),type:"text",text:"JML IMMOBILIER",x:60,y:35,width:w-120,height:50,fontSize:28,font:"Arial",weight:"700",color:"#c6a15b",opacity:1},
    {id:uid(),type:"image",data:photo.data,name:photo.name,x,y,width:iw,height:ih,opacity:1}
   ];
   if(index===0){
    objects.push({id:uid(),type:"text",text:title.toUpperCase(),x:65,y:Math.min(y+ih+35,900),width:w-130,height:105,fontSize:48,font:"Georgia",weight:"700",color:"#17382f",opacity:1});
    objects.push({id:uid(),type:"text",text:[listing.location,listing.price].filter(Boolean).join("  ·  "),x:65,y:Math.min(y+ih+150,1040),width:w-130,height:65,fontSize:34,font:"Arial",weight:"700",color:"#a47e39",opacity:1});
    if(facts)objects.push({id:uid(),type:"text",text:facts,x:65,y:Math.min(y+ih+225,1120),width:w-130,height:70,fontSize:27,font:"Arial",weight:"600",color:"#17382f",opacity:1});
   }else{
    objects.push({id:uid(),type:"text",text:title,x:65,y:900,width:w-130,height:110,fontSize:38,font:"Georgia",weight:"700",color:"#17382f",opacity:1});
    objects.push({id:uid(),type:"text",text:[listing.location,listing.price,facts].filter(Boolean).join("  ·  "),x:65,y:1030,width:w-130,height:100,fontSize:27,font:"Arial",weight:"600",color:"#a47e39",opacity:1});
   }
   return {background:"#f6f2e9",objects};
  });
  pageIndex=0;selectedId=null;projectName="Annonce "+(listing.reference||listing.location||"JML");
  $("format").value="portrait";window.currentJmlProjectId=null;fitCanvas();renderPages();select(null);
  summary.hidden=false;summary.textContent=title+" · "+(listing.location||"Localisation non détectée")+" · "+photos.length+" photo(s) importée(s)"+(listing.photoStatus==="partial"?" · Galerie partielle":"");
  status("Annonce importée : "+photos.length+" photo(s) originale(s), "+pages.length+" page(s) créées. Tu peux maintenant modifier les visuels.");
 }catch(error){status("Import impossible : "+error.message);summary.hidden=false;summary.textContent=error.message}
 finally{button.disabled=false;button.textContent="Importer l’annonce"}
}
$("importListing").onclick=importListing;
$("listingUrl").addEventListener("keydown",event=>{if(event.key==="Enter")importListing()});
function renderTemplates(){$("templates").replaceChildren();(window.JML_TEMPLATES||[]).forEach(template=>{const button=document.createElement("button");button.className="template-card";const swatch=document.createElement("div");swatch.className="template-swatch";swatch.style.background=template.bg;swatch.style.color=template.accent;swatch.textContent="JML";const label=document.createElement("strong");label.textContent=template.name;button.append(swatch,label);button.onclick=()=>applyTemplate(template);$("templates").append(button)})}
function applyTemplate(template){page().background=template.bg;page().objects=[{id:uid(),type:"text",text:template.title,x:70,y:canvas.height*.24,width:canvas.width-140,height:canvas.height*.18,fontSize:Math.round(canvas.width*.055),font:"Georgia",color:template.accent,weight:"700",opacity:1},{id:uid(),type:"text",text:template.subtitle,x:75,y:canvas.height*.43,width:canvas.width-150,height:canvas.height*.14,fontSize:Math.round(canvas.width*.027),font:"Arial",color:template.layout==="editorial"?"#17382f":"#f6f2e9",weight:"600",opacity:1}];if(template.layout==="property")page().objects.push({id:uid(),type:"rect",x:70,y:canvas.height*.66,width:canvas.width-140,height:canvas.height*.2,color:template.accent,opacity:.95});select(null);draw();status("Modèle « "+template.name+" » appliqué. Ajoute tes photos et adapte les textes.")}
function renderPages(){$("pages").replaceChildren();pages.forEach((item,index)=>{const button=document.createElement("button");button.className="page-chip"+(index===pageIndex?" active":"");button.textContent="Page "+(index+1);button.onclick=()=>{pageIndex=index;select(null);renderPages();draw()};$("pages").append(button)});$("pageLabel").textContent="Page "+(pageIndex+1)+" / "+pages.length}
$("addPage").onclick=()=>{pages.push({background:"#f6f2e9",objects:[]});pageIndex=pages.length-1;select(null);renderPages();draw()};
function openDB(){return new Promise((resolve,reject)=>{const request=indexedDB.open("jml-studio-independent",1);request.onupgradeneeded=()=>request.result.createObjectStore("projects",{keyPath:"id"});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})}
async function refreshProjects(){if(!db)return;const request=db.transaction("projects","readonly").objectStore("projects").getAll();request.onsuccess=()=>{$("projectList").replaceChildren(new Option("Choisir un projet…",""));request.result.forEach(project=>$("projectList").add(new Option(project.name,project.id)))}}
async function saveProject(){try{if(!db)db=await openDB();const id=window.currentJmlProjectId||uid();window.currentJmlProjectId=id;const data={id,name:projectName,format:$("format").value,pages:JSON.parse(JSON.stringify(pages)),updatedAt:new Date().toISOString()};await new Promise((resolve,reject)=>{const transaction=db.transaction("projects","readwrite");transaction.objectStore("projects").put(data);transaction.oncomplete=resolve;transaction.onerror=()=>reject(transaction.error)});await refreshProjects();$("projectList").value=id;status("Projet enregistré sur cet appareil : "+projectName)}catch(error){status("Enregistrement impossible : "+error.message)}}
async function loadProject(){try{if(!db)db=await openDB();const id=$("projectList").value;if(!id)return status("Choisis un projet.");const data=await new Promise((resolve,reject)=>{const request=db.transaction("projects","readonly").objectStore("projects").get(id);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});if(!data)return;projectName=data.name;pages=data.pages;pageIndex=0;$("format").value=data.format;window.currentJmlProjectId=id;for(const p of pages)for(const object of p.objects)if(object.type==="image")await getImage(object.data);fitCanvas();renderPages();select(null);status("Projet ouvert : "+projectName)}catch(error){status("Ouverture impossible : "+error.message)}}
$("saveProject").onclick=saveProject;$("loadProject").onclick=loadProject;
$("newProject").onclick=()=>{if(!confirm("Créer un nouveau projet ? Les modifications non enregistrées seront perdues."))return;pages=[{background:"#f6f2e9",objects:[]}];pageIndex=0;window.currentJmlProjectId=null;projectName="Ma création JML";renderPages();select(null);draw();status("Nouveau projet.")};
async function renderPageBlob(index){const p=pages[index],[width,height]=sizes[$("format").value],output=document.createElement("canvas");output.width=width;output.height=height;const context=output.getContext("2d");context.fillStyle=p.background||"#f6f2e9";context.fillRect(0,0,width,height);for(const object of p.objects){if(object.type==="image")await getImage(object.data);drawObject(object,context)}return new Promise((resolve,reject)=>output.toBlob(blob=>blob?resolve(blob):reject(new Error("Export PNG impossible.")),"image/png"))}
function download(blob,name){const url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000)}
async function exportOne(){try{const blob=await renderPageBlob(pageIndex);download(blob,"JML-Studio-page-"+(pageIndex+1)+".png");status("Export PNG terminé.")}catch(error){status("Export impossible : "+error.message)}}
$("exportPage").onclick=exportOne;
function crc32(bytes){let crc=-1;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}return(crc^-1)>>>0}
function makeZip(entries){const encoder=new TextEncoder(),local=[],central=[];let offset=0;for(const entry of entries){const name=encoder.encode(entry.name),data=entry.bytes,crc=crc32(data),header=new Uint8Array(30+name.length),view=new DataView(header.buffer);view.setUint32(0,0x04034b50,true);view.setUint16(4,20,true);view.setUint16(6,0x0800,true);view.setUint16(8,0,true);view.setUint32(14,crc,true);view.setUint32(18,data.length,true);view.setUint32(22,data.length,true);view.setUint16(26,name.length,true);header.set(name,30);local.push(header,data);const directory=new Uint8Array(46+name.length),dv=new DataView(directory.buffer);dv.setUint32(0,0x02014b50,true);dv.setUint16(4,20,true);dv.setUint16(6,20,true);dv.setUint16(8,0x0800,true);dv.setUint16(10,0,true);dv.setUint32(16,crc,true);dv.setUint32(20,data.length,true);dv.setUint32(24,data.length,true);dv.setUint16(28,name.length,true);dv.setUint32(42,offset,true);directory.set(name,46);central.push(directory);offset+=header.length+data.length}const centralSize=central.reduce((sum,item)=>sum+item.length,0),end=new Uint8Array(22),view=new DataView(end.buffer);view.setUint32(0,0x06054b50,true);view.setUint16(8,entries.length,true);view.setUint16(10,entries.length,true);view.setUint32(12,centralSize,true);view.setUint32(16,offset,true);return new Blob([...local,...central,end],{type:"application/zip"})}
async function exportAll(){try{const entries=[];for(let index=0;index<pages.length;index++){status("Préparation de la page "+(index+1)+" / "+pages.length+"…");const blob=await renderPageBlob(index);entries.push({name:"page-"+(index+1)+".png",bytes:new Uint8Array(await blob.arrayBuffer())})}download(makeZip(entries),"JML-Studio-carrousel.zip");status("Export ZIP terminé : "+entries.length+" page(s).")}catch(error){status("Export ZIP impossible : "+error.message)}}
$("exportZip").onclick=exportAll;
renderTemplates();fitCanvas();renderPages();openDB().then(async database=>{db=database;await refreshProjects()}).catch(()=>status("Sauvegarde locale indisponible dans ce navigateur."));
// Arrivée depuis JML Annonce : l'URL source est transmise dans ?listing=...
const incomingListing=new URLSearchParams(location.search).get("listing");
if(incomingListing){
 $("listingUrl").value=incomingListing;
 history.replaceState({},document.title,location.pathname);
 importListing();
}
})();