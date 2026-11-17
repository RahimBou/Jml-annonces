"use strict";
const express=require("express");
const path=require("path");
const app=express();
const PORT=process.env.PORT||3000;
const JML_API=(process.env.JML_ANNONCES_API||"https://jml-annonces.onrender.com/api/scrape").replace(/\/$/,"");
app.use(express.json({limit:"1mb"}));
app.use(express.static(__dirname,{extensions:["html"]}));
function allowedListingUrl(value){const url=new URL(value);if(url.protocol!=="https:"||url.hostname!=="www.jml-immobilier.fr")throw new Error("Seules les annonces du site www.jml-immobilier.fr sont acceptées.");return url.toString()}
function allowedPhotoUrl(value){const url=new URL(value);if(url.protocol!=="https:")throw new Error("URL photo non sécurisée.");if(url.hostname!=="www.jml-immobilier.fr"&&url.hostname!=="jml-immobilier.fr"&&!url.hostname.endsWith(".jml-immobilier.fr"))throw new Error("La photo provient d'un domaine non autorisé : "+url.hostname);return url.toString()}
app.post("/api/import-annonce",async(req,res)=>{
 try{
  const url=allowedListingUrl(String(req.body?.url||"").trim());
  const response=await fetch(JML_API,{method:"POST",headers:{"content-type":"application/json","user-agent":"JML-Studio/1.0"},body:JSON.stringify({url}),signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw new Error("Le service d'import JML Annonce a répondu HTTP "+response.status+".");
  const result=await response.json();
  if(!result.ok||!result.listing)throw new Error(result.error||"Annonce non récupérée.");
  const listing=result.listing;
  const photoUrls=Array.isArray(listing.images)?listing.images.slice(0,8):[];
  const photos=[];
  for(const raw of photoUrls){
   try{
    const photoUrl=allowedPhotoUrl(raw);
    const imageResponse=await fetch(photoUrl,{headers:{"user-agent":"Mozilla/5.0 (compatible; JML-Studio/1.0)"},signal:AbortSignal.timeout(20000)});
    const type=imageResponse.headers.get("content-type")||"";
    if(!imageResponse.ok||!type.startsWith("image/"))continue;
    const bytes=Buffer.from(await imageResponse.arrayBuffer());
    if(bytes.length>5*1024*1024)continue;
    photos.push({name:"photo-"+(photos.length+1),mime:type.split(";")[0],data:"data:"+type.split(";")[0]+";base64,"+bytes.toString("base64")});
   }catch(error){console.warn("Photo non importée:",error.message)}
  }
  res.json({ok:true,listing:{title:listing.title||null,reference:listing.reference||null,price:listing.price||null,location:listing.location||null,surface:listing.surface||null,terrain:listing.terrain||null,rooms:listing.rooms||null,bedrooms:listing.bedrooms||null,description:listing.description||null,highlights:Array.isArray(listing.highlights)?listing.highlights:[],sourceUrl:url,photoStatus:listing.photoStatus||null,expectedPhotoCount:listing.expectedPhotoCount||null},photos,photoCount:photos.length,sourcePhotoCount:photoUrls.length});
 }catch(error){res.status(400).json({ok:false,error:error.message||"Import impossible."})}
});
app.get("/api/health",(req,res)=>res.json({ok:true,service:"jml-studio-independent"}));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.listen(PORT,()=>console.log("JML Studio indépendant démarré sur "+PORT));
