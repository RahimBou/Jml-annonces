"use strict";
const express=require("express");
const path=require("path");
const app=express();
const PORT=process.env.PORT||3000;
const {normalizeUrl,parseListing}=require("./listing-parser");
app.use(express.json({limit:"1mb"}));
app.use(express.static(__dirname,{extensions:["html"]}));
function allowedListingUrl(value){const url=new URL(value);if(url.protocol!=="https:"||url.hostname!=="www.jml-immobilier.fr")throw new Error("Seules les annonces du site www.jml-immobilier.fr sont acceptées.");return url.toString()}
function allowedPhotoUrl(value){const url=new URL(value);if(url.protocol!=="https:")throw new Error("URL photo non sécurisée.");if(url.hostname!=="www.jml-immobilier.fr"&&url.hostname!=="jml-immobilier.fr"&&!url.hostname.endsWith(".jml-immobilier.fr"))throw new Error("La photo provient d'un domaine non autorisé : "+url.hostname);return url.toString()}
app.post("/api/import-annonce",async(req,res)=>{
 try{
  const url=normalizeUrl(String(req.body?.url||"").trim());
  const response=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0 (compatible; JML-Studio/1.0; +https://www.jml-immobilier.fr/)"},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error("JML Immobilier a répondu avec le statut HTTP "+response.status+".");
  const html=await response.text();
  const listing=parseListing(html,url);
  const validated=[];
  for(const imageUrl of listing.images){
   try{
    const imageResponse=await fetch(imageUrl,{headers:{"User-Agent":"Mozilla/5.0 (compatible; JML-Studio/1.0; +https://www.jml-immobilier.fr/)"},signal:AbortSignal.timeout(20000)});
    const type=imageResponse.headers.get("content-type")||"";
    if(!imageResponse.ok||!type.startsWith("image/"))continue;
    const bytes=Buffer.from(await imageResponse.arrayBuffer());
    if(!bytes.length||bytes.length>5*1024*1024)continue;
    validated.push({url:imageUrl,mime:type.split(";")[0],data:"data:"+type.split(";")[0]+";base64,"+bytes.toString("base64")});
   }catch(error){console.warn("Photo annonce non importée:",error.message)}
  }
  listing.images=validated.map(photo=>photo.url);
  listing.imageCount=validated.length;
  const complete=validated.length>0&&!listing.photoExtraction.suspicious&&(listing.expectedPhotoCount==null||validated.length===listing.expectedPhotoCount);
  listing.photoStatus=validated.length===0?"unreliable":complete?"complete":"partial";
  res.json({ok:true,listing:{title:listing.title,reference:listing.reference,price:listing.price,location:listing.location,surface:listing.surface,terrain:listing.terrain,rooms:listing.rooms,bedrooms:listing.bedrooms,description:listing.description,highlights:listing.highlights,sourceUrl:url,photoStatus:listing.photoStatus,expectedPhotoCount:listing.expectedPhotoCount,photoExtraction:listing.photoExtraction},photos:validated,photoCount:validated.length,sourcePhotoCount:listing.imageCount});
 }catch(error){res.status(400).json({ok:false,error:error.message||"Import impossible."})}
});
app.get("/api/health",(req,res)=>res.json({ok:true,service:"jml-studio-independent"}));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.listen(PORT,()=>console.log("JML Studio indépendant démarré sur "+PORT));
