import { handleUpdate } from "../bot/worker.mjs";
import { matches } from "../bot/catalog.mjs";

export async function flowEval(flow,env) {
  const actor=700000000+Math.floor(Math.random()*10000000);
  let updateId=Date.now()*1000+Math.floor(Math.random()*100);
  const sent=[];
  const reply=async(method,data)=>{sent.push({method,data});return {};};
  const input=async(text,callback=false)=>{
    const message={message_id:1,chat:{id:actor,type:"private"},from:{id:actor},text};
    const update={update_id:updateId++,...(callback
      ? {callback_query:{id:String(updateId),from:{id:actor},message,data:text}}
      : {message})};
    await handleUpdate(env,update,reply);
  };
  const last=()=>sent.at(-1)?.data;
  const action=(prefix)=>last()?.reply_markup?.inline_keyboard.flat().find(b=>b.callback_data?.startsWith(prefix))?.callback_data;
  const click=async prefix=>{
    const data=action(prefix);
    if (!data) throw new Error("No action "+prefix+"; "+(last()?.text ?? last()?.caption));
    await input(data,true);
  };
  await input("/start");
  let expected;
  if (flow==="guided") {
    await input("guided",true);
    const type=last().reply_markup.inline_keyboard.flat().find(b=>b.callback_data?.endsWith(":movie"));
    await input(type.callback_data,true);
    const genre=last().reply_markup.inline_keyboard.flat().find(b=>b.callback_data?.endsWith(":action"));
    await input(genre.callback_data,true);
    const limit=last().reply_markup.inline_keyboard.flat().find(b=>b.text==="زیر دو ساعت");
    await input(limit.callback_data,true);
    expected={media_type:"movie",genres:["action"],max_runtime_minutes:119};
  } else {
    const queries={
      bounds:"یه فیلم زیر یک ساعت و نیم اکشن مال قبل از سال ۲۰۰۰ آمریکایی",
      director:"از کارگردان Steven Spielberg یه فیلم اکشن زیر دو ساعت میخوام",
      partial:"یه فیلم علمی تخیلی با پایان خوش",
      hope:"فیلمی که به آدم امید بده",
      hope_drama:"فیلمی که به آدم امید بده ژانر درام",
      hope_followup:"فیلمی که به آدم امید بده",
      geek:"یه فیلم گیک طوری",
      technology:"یه فیلم فناورگونه",
      eerie:"یه فیلم وهم انگیز",
      teen:"یه سریال تینجری رومانتیک",
    };
    if (!queries[flow]) throw new Error("Unknown flow");
    await input(queries[flow]);
    if (flow==="hope_followup") await input("ژانر درام");
    if (flow==="partial" && !last()?.text?.includes("نوع پایان")) throw new Error("Ending warning missing");
    const row=await env.BOT_DB.prepare("SELECT document FROM worker_state WHERE user_id=(SELECT id FROM users WHERE telegram_id=?)").bind(actor).first();
    const state=JSON.parse(row?.document ?? "{}");
    if (state.mode!=="interpret") return {flow,pass:false,stage:"interpretation",message:last()?.text};
    expected=state.query;
    if (["hope","hope_drama","hope_followup"].includes(flow) && !expected.moods?.includes("uplifting")) throw new Error("Hope preference lost");
    if (["hope_drama","hope_followup"].includes(flow) && !expected.genres?.includes("drama")) throw new Error("Drama preference lost");
    if (flow==="geek" && !expected.themes?.includes("geek")) throw new Error("Geek preference lost");
    if (flow==="technology" && !expected.themes?.includes("technology")) throw new Error("Technology preference lost");
    if (flow==="teen" && (!expected.themes?.includes("teen") || !expected.genres?.includes("romance"))) throw new Error("Teen romance lost");
    if (flow==="bounds" && (expected.release_year_max!==1999 || expected.max_runtime_minutes!==89 || expected.country!=="US")) {
      throw new Error("Lost screenshot constraints");
    }
    if (flow==="director" && (expected.director_name!=="Steven Spielberg" || !expected.genres?.includes("action") || expected.max_runtime_minutes!==119)) {
      throw new Error("Lost director constraints");
    }
    await click("interpret:");
  }
  const row=await env.BOT_DB.prepare("SELECT m.metadata_json FROM recommendations r JOIN users u ON u.id=r.user_id JOIN media m ON m.id=r.media_id WHERE u.telegram_id=? ORDER BY r.rowid DESC LIMIT 1").bind(actor).first();
  if (!row) return {flow,pass:false,stage:"catalog",message:last()?.text};
  const media=JSON.parse(row.metadata_json);
  if (!matches(media,expected)) throw new Error("Displayed media violates filters");
  if (flow==="director" && !media.director_match?.includes("Steven Spielberg")) throw new Error("Director not verified");
  await click("next:");
  const next=await env.BOT_DB.prepare("SELECT m.metadata_json FROM recommendations r JOIN users u ON u.id=r.user_id JOIN media m ON m.id=r.media_id WHERE u.telegram_id=? ORDER BY r.rowid DESC LIMIT 1").bind(actor).first();
  if (next && !matches(JSON.parse(next.metadata_json),expected)) throw new Error("Next media violates filters");
  return {flow,pass:true,title:media.title,year:media.release_date,runtime:media.runtime_minutes,countries:media.countries};
}
