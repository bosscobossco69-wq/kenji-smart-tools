import test from "node:test";
import assert from "node:assert/strict";
import { configuredTelegramPilot, safeTokenMatch, telegramMessage, postTelegramMessage, generateTelegramReply } from "../lib/telegram-pilot.js";

const env={TELEGRAM_BOT_TOKEN:"123456789:abcdefghijklmnopqrstuvwxyzABCDE",TELEGRAM_WEBHOOK_SECRET:"s".repeat(40),TELEGRAM_OWNER_UID:"firebase-user-1",TELEGRAM_ALLOWED_CHAT_ID:"12345"};
test("pilot is disabled without all configured secrets",()=>{
 assert.equal(configuredTelegramPilot(),null);
 assert.equal(configuredTelegramPilot({...env,TELEGRAM_ALLOWED_CHAT_ID:""}),null);
 assert.equal(configuredTelegramPilot(env).uid,"firebase-user-1");
});
test("secret comparison rejects missing, mismatched and invalid lengths",()=>{
 assert.equal(safeTokenMatch("good","good"),true);
 assert.equal(safeTokenMatch("bad","good"),false);
 assert.equal(safeTokenMatch(undefined,"good"),false);
 assert.equal(safeTokenMatch("otherlong","good"),false);
});
test("Telegram only accepts text in an explicitly allowed private chat",()=>{
 const update={update_id:123,message:{message_id:456,chat:{type:"private",id:12345},from:{id:1,is_bot:false},text:"  Hello there  "}};
 const msg=telegramMessage(update,"12345");
 assert.equal(msg.text,"Hello there");
 assert.equal(msg.requestId,telegramMessage(update,"12345").requestId);
 assert.equal(telegramMessage(update,"999"),null);
 assert.equal(telegramMessage({...update,message:{...update.message,chat:{type:"group",id:12345}}},"12345"),null);
 assert.equal(telegramMessage({...update,message:{...update.message,text:"/start"}},"12345"),null);
 assert.equal(telegramMessage({...update,message:{...update.message,text:"x".repeat(1201)}},"12345"),null);
 assert.equal(telegramMessage({...update,message:{...update.message,from:{is_bot:true}}},"12345"),null);
 assert.equal(telegramMessage({...update,update_id:"malformed"},"12345"),null);
});
test("Telegram HTTP send rejects unsuccessful API acknowledgments",async()=>{
 const fake=async (url,options)=>{assert.match(url,/\/sendMessage$/);const data=JSON.parse(options.body);assert.equal(data.chat_id,"12345");return {ok:true,json:async()=>({ok:true})};};
 await postTelegramMessage(env.TELEGRAM_BOT_TOKEN,"12345","Hello",fake);
 await assert.rejects(postTelegramMessage(env.TELEGRAM_BOT_TOKEN,"12345","Hello",async()=>({ok:false,json:async()=>({ok:false})})));
});
test("AI reply fails closed when provider is unsuccessful",async()=>{
 await assert.rejects(generateTelegramReply("key","Hi",async()=>({ok:false})));
 const reply=await generateTelegramReply("key","Hi",async(url,options)=>{
  assert.match(url,/api\.groq\.com/);
  assert.equal(JSON.parse(options.body).messages[1].content,"Hi");
  return {ok:true,json:async()=>({choices:[{message:{content:" Welcome! "}}]})};
 });
 assert.equal(reply,"Welcome!");
});
