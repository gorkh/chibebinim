import assert from "node:assert/strict";
import {test} from "node:test";
import {personChoices,resolvePerson,resolveTitles} from "./entities.mjs";
import {validateInterpretation} from "./language.mjs";

const filmmaker={id:42,name:"Ava DuVernay",known_for_department:"Directing",
  also_known_as:["ایوا دوورنی"],known_for:[{title:"Selma"}]};
test("A catalog alias identifies the person without a handwritten mapping",()=>{
  assert.equal(personChoices([filmmaker],"ایوا دوورنی").selected.id,42);
});
test("Short surnames and English hints are choices, not assumed identities",()=>{
  const result=personChoices([{id:99,name:"Sofia Coppola"},{id:100,name:"Francis Ford Coppola"}],"کوپولا");
  assert.equal(result.peopleChoices.length,2);
  assert.ok(!result.selected);
});
test("Catalog homonyms require user selection",()=>{
  const result=personChoices([{id:1,name:"Same Name"},{id:2,name:"Same Name"}],"Same Name");
  assert.equal(result.peopleChoices.length,2);
  assert.equal(personChoices(result.peopleChoices,"Same Name",2).selected.id,2);
});
test("A shared surname does not automatically select the only alias match",()=>{
  const result=personChoices([
    {id:7,name:"Hayao Miyazaki",also_known_as:["میازاکی"]},
    {id:8,name:"Goro Miyazaki"},
  ],"میازاکی");
  assert.ok(!result.selected);
  assert.equal(result.peopleChoices.length,2);
});
test("Foreign original names and Unicode accents match catalog names",()=>{
  assert.equal(personChoices([{id:3,name:"Guillermo del Toro"}],"Guillermo del Toro").selected.id,3);
  assert.equal(personChoices([{id:4,name:"Céline Sciamma"}],"Celine Sciamma").selected.id,4);
});
test("A person is not discarded because their best-known job is acting",()=>{
  assert.equal(personChoices([{id:5,name:"Greta Gerwig",known_for_department:"Acting"}],"Greta Gerwig").selected.id,5);
});
test("Acting requests rank acting identities before directing identities",()=>{
  const result=personChoices([
    {id:20,name:"Tom Example",known_for_department:"Directing"},
    {id:21,name:"Tom Example",known_for_department:"Acting"},
  ],"Tom Example",undefined,"Acting");
  assert.equal(result.peopleChoices[0].id,21);
});
test("Search both the original name and a hint, then verify published aliases",async()=>{
  const searched=[];
  const get=async(path,params)=>{
    if (path==="search/person") {searched.push(params.query);return {results:params.query==="Ava DuVernay" ? [{id:42,name:"Ava DuVernay"}] : []};}
    assert.equal(path,"person/42");
    return filmmaker;
  };
  const result=await resolvePerson(get,"ایوا دوورنی","Ava DuVernay");
  assert.deepEqual(searched,["ایوا دوورنی","Ava DuVernay"]);
  assert.equal(result.selected.id,42);
});
test("An unverified translation never silently chooses a person",async()=>{
  const get=async(path,params)=>path==="search/person"
    ? {results:params.query==="Unrelated Director" ? [{id:6,name:"Unrelated Director"}] : []}
    : {id:6,name:"Unrelated Director",also_known_as:[]};
  const result=await resolvePerson(get,"یک نام فارسی","Unrelated Director");
  assert.ok(!result.selected);
  assert.equal(result.peopleChoices[0].id,6);
});
test("Published multilingual names can recover an incorrect model hint",async()=>{
  const get=async(path,params)=>path==="search/person"
    ? {results:params.query==="Published Name" ? [{id:11,name:"Published Name"}] : []}
    : {id:11,name:"Published Name",also_known_as:[]};
  const result=await resolvePerson(get,"نام فارسی","Wrong Guess",async()=>["Published Name"]);
  assert.equal(result.peopleChoices[0].id,11);
  assert.ok(!result.selected);
});
test("An optional knowledge outage preserves existing catalog choices",async()=>{
  const get=async(path)=>path==="search/person"
    ? {results:[{id:12,name:"Catalog Person"}]} : {id:12,name:"Catalog Person",also_known_as:[]};
  const result=await resolvePerson(get,"نام فارسی","Catalog Person",async()=>{throw new Error("network");});
  assert.equal(result.peopleChoices[0].id,12);
});
test("A failed search and an empty search are not reported as a definitive miss",async()=>{
  await assert.rejects(resolveTitles(async query=>{
    if (query==="hint") throw new Error("network");
    return [];
  },"original","hint","movie"),/network/);
});
test("Title variants are deduplicated by catalog identity",async()=>{
  const queries=[];
  const result=await resolveTitles(async(query,kind)=>{
    queries.push([query,kind]);
    return [{id:"same-film",title:"A film"}];
  },"نام فارسی","Original Title","movie");
  assert.equal(result.length,1);
  assert.equal(queries.length,2);
});
test("A failed optional search does not discard results of the other variant",async()=>{
  const result=await resolveTitles(async query=>{
    if (query==="original") throw new Error("network");
    return [{id:"found"}];
  },"original","hint","movie");
  assert.equal(result[0].id,"found");
});
test("Hints are separate from the user's literal director name",()=>{
  const result=validateInterpretation({
    filters:{media_type:"movie",genres:["science_fiction"],director_name:"اسپیلبرگ"},
    evidence:{media_type:"فیلم",genres:"علمی تخیلی",director_name:"اسپیلبرگ"},
    search_hints:{director_name:"Steven Spielberg"},unsupported:[],ambiguous:[],ignored:["یه","از"],unrelated:false,
  },"یه فیلم علمی تخیلی از اسپیلبرگ");
  assert.equal(result.status,"understood");
  assert.equal(result.query.director_name,"اسپیلبرگ");
  assert.equal(result.query.search_hints.director_name,"Steven Spielberg");
});
test("The model cannot assign a trusted catalog id",()=>{
  const result=validateInterpretation({
    filters:{director_name:"Nolan",_director_id:525},evidence:{director_name:"Nolan",_director_id:"Nolan"},
    unsupported:[],ambiguous:[],ignored:[],unrelated:false,
  },"Nolan");
  assert.equal(result.query,null);
});
