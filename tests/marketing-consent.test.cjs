const {test}=require("node:test");
const assert=require("node:assert/strict");
const {readFileSync}=require("node:fs");
const {join}=require("node:path");
const get=p=>readFileSync(join(__dirname,"..",p),"utf8");
test("marketing signup is optional and unchecked",()=>{
 const c=get("workspace/signup.html");
 assert.match(c, /type="checkbox" id="marketingConsent"/);
 assert.doesNotMatch(c,/type="checkbox" id="marketingConsent"[^>]*checked/);
 assert.match(c,/marketing_preference/);
});
test("marketing worker cannot send by default, verifies emails and purchases",()=>{
 const c=get("lib/marketing-followups.js");
 assert.match(c,/MARKETING_EMAILS_ENABLED!=="true"/);
 assert.match(c,/!person.emailVerified/);
 assert.match(c,/orders.docs.some/);
 assert.match(c,/webOrders.docs.some/);
 assert.match(c,/savedPref.data\(\).marketingConsent!==true/);
 assert.match(c,/unsubscribe\.html/);
});
test("essential annual grant job isolates optional marketing exceptions",()=>{
 const c=get("api/stripe-annual-credit-grant.js");
 assert.match(c,/try \{ marketing=await runMarketingFollowups\(\{db,auth\}\); \}/);
 assert.match(c,/\[kenji-marketing\]/);
});
test("preference save authenticates Firebase token, and public unsubscribe is signed",()=>{
 const a=get("api/account-billing.js");
 const b=get("api/website-order.js");
 const c=get("lib/marketing-consent.js");
 assert.match(a,/verifyIdToken\(token, true\)/);
 assert.match(a,/typeof req.body\?\.marketingConsent !== "boolean"/);
 assert.match(b,/unsubscribeBySignature/);
 assert.match(c,/timingSafeEqual/);
});
