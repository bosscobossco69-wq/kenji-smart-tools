/* KENJI feedback: no tool contents, credentials, checkout IDs or customer emails transmitted. */
(()=>{
const FB="https://www.facebook.com/share/1DyXpVkJEK/?mibextid=wwXIfr";
const path=location.pathname;
const authPage=/^\/workspace\/(?:login|signup|forgot-password)(?:\.(?:ms|es|th|zh-CN|zh-TW))?\.html$/.test(path);
const words={
en:["Rate your experience","Your feedback helps us improve.","Choose a rating from 1 to 5","Feedback category","Tell us what could be improved (optional)","Submit feedback","Maybe later","Thank you for your feedback!","Visit us on Facebook","Review or recommend on Facebook","Share KENJI","Contact me about this feedback","Please do not include private information or passwords.","Unable to submit. Try again later.","Sign in with a verified email to rate.","Overall|Design|Ease of use|AI tools|Speed|Login|Payment|Support|Feature request|Other","Very dissatisfied|Dissatisfied|Average|Satisfied|Excellent","Language","Rate KENJI"],
"zh-CN":["为使用体验评分","您的反馈帮助我们改进。","请选择1至5颗星","反馈分类","有什么需要改进？（选填）","提交反馈","稍后评价","感谢您的反馈！","访问 Facebook 专页","在 Facebook 评价或推荐","分享 KENJI","同意客服就此反馈联系我","请勿输入私人信息、密码或验证码。","暂时无法提交，请稍后重试。","请登录并验证邮箱后评分。","整体|设计|操作体验|AI工具|速度|登录|付款|客服|功能建议|其他","非常不满意|不满意|一般|满意|非常满意","语言","评价 KENJI"],
"zh-TW":["為使用體驗評分","您的回饋幫助我們改善。","請選擇1至5顆星","回饋分類","有什麼需要改善？（選填）","提交回饋","稍後評價","感謝您的回饋！","瀏覽 Facebook 專頁","在 Facebook 評價或推薦","分享 KENJI","同意客服就此回饋聯絡我","請勿輸入私人資料、密碼或驗證碼。","暫時無法提交，請稍後重試。","請登入並驗證電子郵件後評分。","整體|設計|操作體驗|AI工具|速度|登入|付款|客服|功能建議|其他","非常不滿意|不滿意|普通|滿意|非常滿意","語言","評價 KENJI"],
th:["ให้คะแนนประสบการณ์","ความคิดเห็นของคุณช่วยเราปรับปรุง","เลือก 1 ถึง 5 ดาว","หมวดหมู่","สิ่งที่ควรปรับปรุง (ไม่บังคับ)","ส่งความคิดเห็น","ไว้ภายหลัง","ขอบคุณสำหรับความคิดเห็น!","เยี่ยมชม Facebook","รีวิวหรือแนะนำบน Facebook","แชร์ KENJI","ยินยอมให้ติดต่อเรื่องความคิดเห็นนี้","ห้ามใส่ข้อมูลส่วนตัว รหัสผ่าน หรือรหัสยืนยัน","ส่งไม่ได้ โปรดลองอีกครั้ง","เข้าสู่ระบบและยืนยันอีเมลก่อนให้คะแนน","ภาพรวม|ดีไซน์|การใช้งาน|AI|ความเร็ว|เข้าสู่ระบบ|การชำระเงิน|บริการ|ข้อเสนอแนะ|อื่นๆ","ไม่พอใจมาก|ไม่พอใจ|ปานกลาง|พอใจ|ดีเยี่ยม","ภาษา","ให้คะแนน KENJI"],
es:["Califica tu experiencia","Tu opinión nos ayuda a mejorar.","Elige de 1 a 5 estrellas","Categoría","¿Qué podemos mejorar? (opcional)","Enviar opinión","Más tarde","¡Gracias por tu opinión!","Visítanos en Facebook","Reseña o recomienda en Facebook","Compartir KENJI","Acepto que me contacten por esta opinión","No incluyas datos privados ni contraseñas.","No se pudo enviar. Intenta más tarde.","Inicia sesión con correo verificado.","General|Diseño|Facilidad de uso|IA|Velocidad|Acceso|Pagos|Soporte|Sugerencia|Otros","Muy insatisfecho|Insatisfecho|Normal|Satisfecho|Excelente","Idioma","Califica KENJI"],
ms:["Nilai pengalaman anda","Maklum balas membantu kami menambah baik.","Pilih 1 hingga 5 bintang","Kategori","Apakah yang boleh diperbaiki? (pilihan)","Hantar maklum balas","Kemudian","Terima kasih atas maklum balas!","Lawati Facebook kami","Ulas atau cadangkan di Facebook","Kongsi KENJI","Setuju dihubungi tentang maklum balas ini","Jangan masukkan maklumat peribadi atau kata laluan.","Tidak dapat menghantar. Cuba lagi nanti.","Log masuk dengan e-mel disahkan.","Keseluruhan|Reka bentuk|Kemudahan|AI|Kelajuan|Log masuk|Bayaran|Sokongan|Cadangan|Lain-lain","Sangat tidak puas hati|Tidak puas hati|Sederhana|Puas hati|Cemerlang","Bahasa","Nilai KENJI"]
};
const langs=Object.keys(words),cats=["overall","design","usability","ai","speed","login","payment","support","feature","other"];
const normalize=s=>/^zh-(TW|HK|Hant)/i.test(s)?"zh-TW":/^zh/i.test(s)?"zh-CN":langs.includes(s)?s:langs.includes(s.split("-")[0])?s.split("-")[0]:"en";
let locale=normalize(path.match(/\.(zh-CN|zh-TW|th|es|ms)\.html$/)?.[1]||navigator.language||document.documentElement.lang||"en");
const e=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
const btn=text=>{const n=e("button",text);n.type="button";return n;};
const addLink=(parent,placement,text,url=FB)=>{const a=e("a",text);a.href=url;a.target="_blank";a.rel="noopener noreferrer";a.className="kf-fb";a.addEventListener("click",()=>{try{fetch("/api/member-feedback",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"click",placement}),keepalive:true,credentials:"omit"}).catch(()=>{});}catch{}});parent.append(a);return a;};
const social=(parent,placement,review=false)=>{const t=words[locale];addLink(parent,placement,t[8]);if(review)addLink(parent,placement,t[9]);addLink(parent,placement,t[10],"https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fkenjismarttools.com%2F");};
const source=path==="/"||path==="/index.html"?"home":path.includes("account.html")?"account":path.includes("website-")?"services":path.startsWith("/workspace/")?"workspace":"tools";
const footer=document.querySelector("footer")||document.body;const bar=e("div");bar.className="kf-links";social(bar,source);footer.append(bar);
const support=()=>{const d=document.getElementById("kenji-help-dialog");if(d&&!d.querySelector(".kf-links")){const b=e("div");b.className="kf-links";social(b,"support");d.append(b);}};
support();document.addEventListener("click",ev=>{if(ev.target.closest?.("#kenji-help-entry"))support();});
let firebase=null,user=null,epoch=0,busy=false,eligible=false,checking=false,queued=null,feature="workspace",rating=0,nextAt=0,mode="rate";
const dialog=e("dialog");dialog.id="kenji-rating-dialog";dialog.setAttribute("aria-labelledby","kf-title");
const inner=e("div");inner.className="kf-inner";dialog.append(inner);document.body.append(dialog);
const manual=btn(words[locale][18]);manual.className="kf-manual";manual.hidden=true;bar.append(manual);
async function call(body,uid=user?.uid){if(!uid||firebase?.auth.currentUser?.uid!==uid)throw Error(words[locale][14]);const token=await firebase.auth.currentUser.getIdToken();if(firebase.auth.currentUser?.uid!==uid)throw Error("Account changed");const r=await fetch("/api/member-feedback",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+token},body:JSON.stringify(body),cache:"no-store"});const d=await r.json().catch(()=>({}));if(firebase.auth.currentUser?.uid!==uid)throw Error("Account changed");if(!r.ok)throw Error(words[locale][13]);return d;}
function close(){if(dialog.open)dialog.close();}
function render(){
 const t=words[locale];inner.replaceChildren();const title=e("h2",mode==="thanks"?t[7]:t[0]);title.id="kf-title";inner.append(title);
 if(mode==="thanks"){const links=e("div");links.className="kf-links";social(links,"feedback",true);inner.append(links);const done=btn("OK");done.addEventListener("click",close);inner.append(done);return;}
 inner.append(e("p",t[1]));
 const language=e("select");language.setAttribute("aria-label",t[17]);for(const code of langs){const o=e("option",({en:"English","zh-CN":"简体中文","zh-TW":"繁體中文",th:"ไทย",es:"Español",ms:"Bahasa Melayu"})[code]);o.value=code;language.append(o);}language.value=locale;
 const stars=e("fieldset");stars.className="kf-stars";stars.append(e("legend",t[2]));const caption=e("p",t[2]);caption.setAttribute("aria-live","polite");
 const inputs=[];for(let n=1;n<=5;n++){const label=e("label");const radio=e("input");radio.type="radio";radio.name="kenji-rating";radio.value=String(n);radio.setAttribute("aria-label",n+" · "+t[16].split("|")[n-1]);const star=e("span","★");star.setAttribute("aria-hidden","true");label.append(radio,star);stars.append(label);inputs.push({radio,star,n});radio.addEventListener("change",()=>{rating=n;paint();});}
 const category=e("select");category.setAttribute("aria-label",t[3]);cats.forEach((c,i)=>{const o=e("option",t[15].split("|")[i]);o.value=c;category.append(o);});
 const comment=e("textarea");comment.rows=3;comment.maxLength=1000;comment.placeholder=t[4];comment.setAttribute("aria-label",t[4]);
 const consent=e("input");consent.type="checkbox";const consentLabel=e("label",t[11]);consentLabel.className="kf-consent";consentLabel.prepend(consent);
 const submit=btn(t[5]),later=btn(t[6]);later.className="kf-later";const status=e("p");status.setAttribute("role","status");
 function paint(){for(const x of inputs){x.radio.checked=x.n===rating;x.star.classList.toggle("on",x.n<=rating);}caption.textContent=rating?t[16].split("|")[rating-1]:t[2];submit.disabled=!rating||busy;consentLabel.hidden=rating>2||rating===0;if(consentLabel.hidden)consent.checked=false;}
 language.addEventListener("change",()=>{if(busy)return;const c=comment.value,k=category.value,checked=consent.checked;locale=language.value;render();const ns=inner.querySelectorAll("select");ns[1].value=k;inner.querySelector("textarea").value=c;inner.querySelector(".kf-consent input").checked=checked&&rating<=2;});
 submit.addEventListener("click",async()=>{if(busy||!rating)return;busy=true;paint();later.disabled=true;language.disabled=true;const v=epoch,uid=user?.uid;try{const data=await call({action:"submit",rating,category:category.value,feature,language:locale,device:matchMedia("(max-width:760px)").matches?"mobile":"desktop",comment:comment.value,contactConsent:rating<=2&&consent.checked},uid);if(v!==epoch)return;eligible=false;manual.hidden=true;queued=null;nextAt=data.nextAt;mode="thanks";rating=0;render();}catch{if(v===epoch)status.textContent=t[13];}finally{if(v===epoch){busy=false;paint();later.disabled=false;language.disabled=false;}}});
 later.addEventListener("click",()=>void dismiss());
 inner.append(language,stars,caption,category,comment,e("small",t[12]),consentLabel,submit,later,status);paint();
}
async function dismiss(){if(busy)return;const uid=user?.uid;eligible=false;manual.hidden=true;queued=null;nextAt=Date.now()+7*86400000;close();try{await call({action:"dismiss"},uid);}catch{}}
dialog.addEventListener("cancel",ev=>{ev.preventDefault();if(mode==="thanks")close();else void dismiss();});
function open(f){if(authPage||!eligible||!user?.emailVerified||dialog.open||document.querySelector("dialog[open]")||document.hidden)return false;feature=f;mode="rate";rating=0;render();if(typeof dialog.showModal!=="function")return false;dialog.showModal();return true;}
async function check(){if(authPage||checking||!user?.emailVerified)return;checking=true;const v=epoch;try{const d=await call({action:"eligibility"});if(v!==epoch)return;eligible=d.eligible;nextAt=d.nextAt;manual.hidden=!eligible;if(eligible&&queued)tryOpen();}catch{}finally{checking=false;if(v!==epoch&&user?.emailVerified)void check();}}
let timer=null;
function tryOpen(){clearTimeout(timer);timer=setTimeout(()=>{if(!queued||!eligible)return;if(document.hidden||document.querySelector("dialog[open]")||document.activeElement?.matches("input,textarea,select,[contenteditable=true]")){tryOpen();return;}if(open(queued))queued=null;},1600);}
window.addEventListener("kenji:feedback-success",ev=>{const f=ev.detail?.feature;if(authPage||typeof f!=="string")return;queued=f;if(user?.emailVerified){if(eligible)tryOpen();else if(nextAt<=Date.now())void check();}});
manual.addEventListener("click",()=>{if(eligible)open(queued||(source==="account"?"account":"workspace"));});
(async()=>{try{firebase=await import("/workspace/firebase-auth.js");await firebase.authReady;firebase.onAuthStateChanged(firebase.auth,u=>{if(user&&user.uid!==u?.uid)queued=null;epoch++;user=u;eligible=false;nextAt=0;manual.hidden=true;busy=false;close();if(u?.emailVerified)void check();});}catch{}})();
})();
