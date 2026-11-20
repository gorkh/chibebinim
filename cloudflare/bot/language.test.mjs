import assert from "node:assert/strict";
import { test } from "node:test";
import { needsModel, validateInterpretation, interpret, continueRequest } from "./language.mjs";
import { matches } from "./catalog.mjs";

export const contract = (filters,evidence,extra={}) => ({
  filters,evidence,unsupported:[],ambiguous:[],ignored:[],unrelated:false,...extra,
});
test("Every free text request uses the model",()=>{
  for (const input of ["فیلم اکشن","از کارگردان Steven Spielberg یه فیلم اکشن میخوام","قیمت دلار؟"]) assert.ok(needsModel(input));
});
test("A numeric correction replaces the previous numeric clause",()=>{
  const state={mode:"clarify",expires:Date.now()+60000,draft:"یه فیلم اکشن زیر دو ساعت",
    evidence:{max_runtime_minutes:"زیر دو ساعت"}};
  const combined=continueRequest(state,"حداکثر ۹۰ دقیقه");
  assert.ok(combined.includes("اکشن"));
  assert.ok(combined.includes("۹۰"));
  assert.ok(!combined.includes("دو ساعت"));
});
test("All screenshot constraints survive the contract",()=>{
  const result=validateInterpretation(contract(
    {media_type:"movie",genres:["action"],release_year_max:1999,max_runtime_minutes:89,country:"US"},
    {media_type:"فیلم",genres:"اکشن",release_year_max:"قبل از سال ۲۰۰۰",max_runtime_minutes:"زیر یک ساعت و نیم",country:"آمریکایی"}),
    "یه فیلم زیر یک ساعت و نیم اکشن مال قبل از سال ۲۰۰۰ آمریکایی");
  assert.equal(result.status,"understood");
  assert.equal(result.query.release_year_max,1999);
});
test("Omitted date is rejected even with otherwise valid JSON",()=>{
  const result=validateInterpretation(contract({media_type:"movie",genres:["action"]},
    {media_type:"فیلم",genres:"اکشن"}),"یه فیلم اکشن قبل از سال ۲۰۰۰");
  assert.equal(result.status,"incomplete_coverage");
  assert.equal(result.query,null);
});
test("Covering the entire text with a quote cannot bypass numeric validation",()=>{
  const result=validateInterpretation(contract({media_type:"movie",genres:["action"]},
    {media_type:"فیلم اکشن قبل از سال ۲۰۰۰",genres:"اکشن"}),"فیلم اکشن قبل از سال ۲۰۰۰");
  assert.equal(result.status,"numeric_mismatch");
});
test("Meaningful conditions cannot be marked as filler",()=>{
  const result=validateInterpretation(contract({media_type:"movie"},{media_type:"فیلم"},
    {ignored:["قبل از سال ۲۰۰۰"]}),"فیلم قبل از سال ۲۰۰۰");
  assert.equal(result.status,"meaningful_text_ignored");
});
test("Unsupported condition is preserved for explicit consent",()=>{
  const result=validateInterpretation(contract({media_type:"movie",genres:["science_fiction"]},
    {media_type:"فیلم",genres:"علمی تخیلی"},{unsupported:[{kind:"ending",text:"با پایان خوش"}]}),
    "یه فیلم علمی تخیلی با پایان خوش");
  assert.equal(result.status,"understood");
  assert.match(result.warning,/نوع پایان/);
});
test("Ambiguous rating asks for a value",()=>{
  const result=validateInterpretation(contract({media_type:"movie"},{media_type:"فیلم"},
    {ambiguous:["امتیاز بالا"]}),"فیلم با امتیاز بالا");
  assert.equal(result.status,"ambiguous");
  assert.equal(result.query,null);
});
test("Two genres must both match",()=>{
  const result=validateInterpretation(contract({media_type:"movie",genres:["action","mystery"]},
    {media_type:"فیلم",genres:"معمایی و اکشن"}),"فیلم معمایی و اکشن");
  assert.equal(result.query.all_genres,true);
  assert.equal(matches({media_type:"movie",genres:["action"]},result.query),false);
});
test("A requested exclusion cannot become a positive genre",()=>{
  const result=validateInterpretation(contract({media_type:"movie",genres:["horror"]},
    {media_type:"فیلم",genres:"ترسناک نباشه"}),"فیلم ترسناک نباشه");
  assert.equal(result.status,"polarity_mismatch");
  assert.equal(result.query,null);
});
test("An explicit genre alternative does not require both genres",()=>{
  const result=validateInterpretation(contract({media_type:"movie",genres:["action","comedy"]},
    {media_type:"فیلم",genres:"کمدی یا اکشن"}),"فیلم کمدی یا اکشن");
  assert.equal(result.query.all_genres,false);
  assert.ok(matches({media_type:"movie",genres:["action"]},result.query));
});
test("Unknown fields and fabricated evidence cannot execute",()=>{
  assert.equal(validateInterpretation(contract({media_type:"movie",foo:1},{media_type:"فیلم",foo:"اکشن"}),"فیلم اکشن").query,null);
  assert.equal(validateInterpretation(contract({director_name:"Nolan"},{director_name:"نولان"}),"یه فیلم").query,null);
});
test("Malformed and failed model outputs recover explicitly",async()=>{
  for (const run of [async()=>({response:"not json"}),async()=>{throw new Error("API unavailable");}]) {
    const result=await interpret({run},"فیلم اکشن");
    assert.ok(["invalid_output","model_unavailable"].includes(result.status));
    assert.equal(result.query,null);
  }
});
