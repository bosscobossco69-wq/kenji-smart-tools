import {cert,getApps,initializeApp} from "firebase-admin/app";
import {getAuth} from "firebase-admin/auth";
import {FieldValue,getFirestore} from "firebase-admin/firestore";
import {inventoryList,createProduct,editProduct,archiveProduct,adjustStock} from "./business-inventory.js";

let services;
async function getServices(){
 if(!services)services=(async()=>{
  const raw=process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const account=JSON.parse(raw||"null");
  if(!account||!process.env.FIREBASE_PROJECT_ID||account.project_id!==process.env.FIREBASE_PROJECT_ID)throw Error("Firebase server configuration missing");
  const app=getApps()[0]||initializeApp({credential:cert(account),projectId:account.project_id});
  return {auth:getAuth(app),db:getFirestore(app)};
 })();
 return services;
}
export default async function handler(req,res){
 res.setHeader("Cache-Control","private, no-store");
 res.setHeader("Vary","Authorization");
 res.setHeader("X-Content-Type-Options","nosniff");
 if(!["GET","POST"].includes(req.method)){res.setHeader("Allow","GET, POST");return res.status(405).json({error:"Method not allowed."});}
 if(req.method==="POST"){
  if(req.headers["content-type"]?.split(";")[0]!=="application/json")return res.status(415).json({error:"JSON body is required."});
  const origin=req.headers.origin;
  if(typeof origin!=="string"||origin!=="https://"+req.headers.host)return res.status(403).json({error:"Invalid request origin."});
  if(!req.body||typeof req.body!=="object"||Array.isArray(req.body)||JSON.stringify(req.body).length>3000)return res.status(400).json({error:"Invalid request body."});
 }
 const header=req.headers.authorization||"";
 if(typeof header!=="string"||!header.startsWith("Bearer ")||header.length>8500)return res.status(401).json({error:"Sign in required."});
 try{
  const {auth,db}=await getServices();
  const identity=await auth.verifyIdToken(header.slice(7),true);
  if(!identity.email_verified)return res.status(403).json({error:"Verify your email before using business inventory."});
  const user=await auth.getUser(identity.uid);
  if(user.disabled||!user.emailVerified)return res.status(403).json({error:"Account is not verified."});
  const environment=process.env.VERCEL_ENV;
  if(req.method==="GET")return res.status(200).json(await inventoryList(db,identity.uid,environment));
  const action=req.body.action;
  const actions={create:()=>createProduct(db,identity.uid,environment,req.body,FieldValue),
    edit:()=>editProduct(db,identity.uid,environment,req.body,FieldValue),
    archive:()=>archiveProduct(db,identity.uid,environment,req.body,FieldValue),
    adjust:()=>adjustStock(db,identity.uid,environment,req.body,FieldValue)};
  if(!Object.hasOwn(actions,action))return res.status(400).json({error:"Unsupported inventory action."});
  const result=await actions[action]();
  return res.status(200).json({ok:true,...result});
 }catch(error){
  if(Number.isInteger(error?.status)&&error.status>=400&&error.status<500)return res.status(error.status).json({error:error.message,code:error.code});
  if(["auth/id-token-expired","auth/argument-error","auth/id-token-revoked"].includes(error?.code))return res.status(401).json({error:"Please sign in again."});
  console.error("[business-inventory]",{code:typeof error?.code==="string"?error.code:"unavailable"});
  return res.status(503).json({error:"Inventory is temporarily unavailable. No changes were confirmed."});
 }
}
