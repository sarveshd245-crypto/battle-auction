import 'dotenv/config';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import cors from 'cors';
import { Server } from 'socket.io';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';

// --------------------------------------------------
// SETUP
// --------------------------------------------------

const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Set CORS_ORIGIN on your host to a comma-separated list of allowed origins,
// e.g. "https://my-frontend.vercel.app". If it is not set, all origins are
// allowed (the old behaviour) so nothing breaks.
const corsList = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const corsOrigin = corsList.length ? corsList : true;

if (!corsList.length) {
  console.warn('CORS_ORIGIN is not set: all origins are allowed. Set it in production.');
}

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '50kb' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOrigin },
  maxHttpBufferSize: 1e5
});

const MAX_PLAYERS = 10;
const STARTING_BUDGET = 100;
const ROOM_IDLE_MS = 30 * 60 * 1000;

const rooms = new Map();
const turnTimers = new Map();
const revealTimers = new Map();
const emitTimers = new Map();
const genreCache = new Map();
const imageCache = new Map();

const GENRES = [
  'Ramayana', 'Mahabharata', 'Football', 'Cricket',
  'Marvel', 'DC', 'Harry Potter', 'Anime'
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clone = value => JSON.parse(JSON.stringify(value));

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function slugify(value) {
  return String(value).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function safeText(value, fallback = '') {
  return String(value || fallback).trim().slice(0, 1000);
}

function cleanName(value, fallback) {
  const cleaned = String(value || '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, 24);
  return cleaned || fallback;
}

function cleanList(value) {
  if (Array.isArray(value)) {
    return value.map(x => String(x).trim()).filter(Boolean).slice(0, 12);
  }
  if (typeof value === 'string') {
    return value.split(',').map(x => x.trim()).filter(Boolean).slice(0, 12);
  }
  return [];
}

function extractJSON(value) {
  const cleaned = String(value || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error('Gemini returned invalid JSON.');
  }
}

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join('');
}

function normalizeCharacter(raw, genre) {
  if (!raw || typeof raw !== 'object' || !raw.name) return null;

  const name = String(raw.name).trim().slice(0, 80);
  const rating = Math.round(Number(raw.rating));

  return {
    id: `${slugify(genre)}-${slugify(name)}`,
    name,
    universe: genre,
    version: String(raw.version || 'General version').slice(0, 100),
    rating: Number.isFinite(rating) ? Math.max(1, Math.min(100, rating)) : 70,
    abilities: cleanList(raw.abilities),
    strengths: cleanList(raw.strengths),
    weaknesses: cleanList(raw.weaknesses),
    description: String(raw.description || '').slice(0, 500),
    combatStyle: String(raw.combatStyle || 'Versatile').slice(0, 150),
    sources: [],
    imageUrl: null
  };
}

// --------------------------------------------------
// GEMINI (standard generateContent API)
// --------------------------------------------------

class GeminiQuotaError extends Error {}

let geminiClient = null;

function resolveModelName() {
  let name = (process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();

  // "-live" models only work over the Live (audio/streaming) API, not for
  // plain text/JSON generation, so map them to the normal text model.
  if (/-live$/i.test(name)) {
    const fixed = name.replace(/-live$/i, '-flash');
    console.warn(
      `GEMINI_MODEL "${name}" is a Live model. Using "${fixed}" instead. Set GEMINI_MODEL to a normal text model to remove this warning.`
    );
    name = fixed;
  }

  return name;
}

function getGeminiClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('Gemini API key is missing. Add GEMINI_API_KEY to your environment variables.');
  }

  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  return geminiClient;
}

async function callGemini(prompt) {
  const client = getGeminiClient();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const response = await client.models.generateContent({
      model: resolveModelName(),
      contents: prompt,
      config: {
        temperature: 0.3,
        maxOutputTokens: 32768,
        responseMimeType: 'application/json',
        abortSignal: controller.signal
      }
    });

    const text = response?.text;

    if (!text || !String(text).trim()) {
      throw new Error('Gemini returned an empty response.');
    }

    return String(text);
  } finally {
    clearTimeout(timeout);
  }
}

function isQuotaError(error) {
  const message = String(error?.message || '').toLowerCase();

  return (
    error?.status === 429 ||
    message.includes('quota') ||
    message.includes('resource_exhausted') ||
    message.includes('billing') ||
    message.includes('limit: 0') ||
    message.includes('429')
  );
}

// Calls Gemini, parses JSON, validates it, and retries on any failure
// (network error, bad JSON, or failed validation).
async function generateJSON(prompt, label, validate = value => value) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const text = await callGemini(prompt);
      return validate(extractJSON(text));
    } catch (error) {
      lastError = error;

      if (isQuotaError(error)) {
        throw new GeminiQuotaError(
          `${label}: Gemini quota or rate limit reached. Check Google AI Studio usage and project limits.`
        );
      }

      if (attempt < 3) {
        const delay = attempt * 2500;
        console.warn(`${label} attempt ${attempt} failed. Retrying in ${delay}ms.`, error.message);
        await sleep(delay);
      }
    }
  }

  throw lastError || new Error(`${label} failed.`);
}

// --------------------------------------------------
// PERMANENT MARVEL AND DC DATABASES
// --------------------------------------------------

function makeCharacter(genre, name, rating, abilities, strengths, weaknesses, description, style) {
  return {
    id: `${slugify(genre)}-${slugify(name)}`,
    name,
    universe: genre,
    version: genre === 'Marvel' ? 'Marvel comics – general continuity' : 'DC comics – general continuity',
    rating,
    abilities,
    strengths,
    weaknesses,
    description,
    combatStyle: style,
    sources: [],
    imageUrl: null
  };
}

const MARVEL_DATA = [
  ['Spider-Man',88,['Spider-sense','Web-slinging','Agility'],['Reflexes','Mobility','Improvisation'],['Human-level durability'],'Peter Parker is a brilliant hero with extraordinary agility and danger awareness.','Fast and mobile'],
  ['Iron Man',91,['Powered armour','Repulsors','Flight'],['Technology','Range','Adaptability'],['Armour dependence'],'Tony Stark is an inventor who uses advanced powered armour.','Technology-driven'],
  ['Thor',96,['Asgardian physiology','Mjolnir','Lightning'],['Strength','Durability','Energy projection'],['Version-dependent limits'],'Thor is an Asgardian warrior with immense strength.','Powerful close combat'],
  ['Captain America',88,['Super-soldier physiology','Shield mastery'],['Leadership','Tactics','Discipline'],['Limited ranged options'],'Steve Rogers is a super-soldier and experienced team leader.','Tactical and defensive'],
  ['Hulk',97,['Gamma-powered strength','Durability'],['Strength','Resilience'],['Variable control'],'Bruce Banner transforms into the immensely strong Hulk.','High strength'],
  ['Black Widow',82,['Espionage','Martial arts','Technology'],['Stealth','Strategy','Agility'],['Human physiology'],'Natasha Romanoff is a highly trained spy and strategist.','Stealth and technique'],
  ['Hawkeye',82,['Archery','Precision','Tactics'],['Accuracy','Awareness'],['Human physiology'],'Clint Barton is an expert archer.','Long-range precision'],
  ['Doctor Strange',97,['Mystic arts','Portals','Spell casting'],['Versatility','Knowledge','Magic'],['Concentration'],'Stephen Strange is a master of the mystic arts.','Mystical and versatile'],
  ['Scarlet Witch',99,['Chaos magic','Energy manipulation'],['Reality manipulation','Power'],['Control varies by version'],'Wanda Maximoff is a powerful magic user.','Reality-altering magic'],
  ['Vision',94,['Density control','Flight','Energy beam'],['Durability','Intelligence','Versatility'],['Specialized vulnerabilities'],'Vision is an android with advanced abilities.','Versatile energy combat'],
  ['Black Panther',89,['Enhanced physiology','Vibranium suit'],['Strategy','Agility','Technology'],['Equipment dependence'],'T\'Challa is the technologically advanced king of Wakanda.','Agile and tactical'],
  ['Captain Marvel',96,['Energy absorption','Flight','Super strength'],['Power','Speed','Durability'],['Power varies by version'],'Carol Danvers is a powerful cosmic hero.','Cosmic energy combat'],
  ['Ant-Man',85,['Size manipulation','Technology'],['Infiltration','Adaptability'],['Suit dependence'],'Scott Lang uses technology to change size.','Size-based tactics'],
  ['Wasp',85,['Size manipulation','Flight','Energy blasts'],['Agility','Precision'],['Suit dependence'],'Janet van Dyne is a founding Avenger.','Agile aerial combat'],
  ['Falcon',83,['Flight suit','Aerial tactics'],['Mobility','Awareness'],['Equipment dependence'],'Sam Wilson is an expert aerial hero.','Aerial support'],
  ['Winter Soldier',86,['Cybernetic arm','Marksmanship'],['Training','Strength','Tactics'],['Human-level limits'],'Bucky Barnes is a highly trained operative.','Tactical combat'],
  ['Daredevil',85,['Enhanced senses','Martial arts'],['Awareness','Technique'],['Human physiology'],'Matt Murdock is a skilled blind lawyer and hero.','Close combat'],
  ['Luke Cage',88,['Super strength','Unbreakable skin'],['Durability','Strength'],['Limited range'],'Luke Cage has extraordinary strength and durability.','Durable close combat'],
  ['Iron Fist',87,['Chi mastery','Martial arts'],['Technique','Focus'],['Energy management'],'Danny Rand is a master martial artist.','Focused martial arts'],
  ['Punisher',84,['Tactics','Marksmanship'],['Planning','Experience'],['Human physiology'],'Frank Castle is a highly trained tactician.','Strategic and ranged'],
  ['Moon Knight',87,['Combat training','Equipment'],['Adaptability','Determination'],['Version-dependent abilities'],'Marc Spector is a complex hero with combat expertise.','Unpredictable tactics'],
  ['Shang-Chi',89,['Martial arts','Ten Rings in some versions'],['Technique','Agility'],['Power depends on version'],'Shang-Chi is a master martial artist.','Martial arts'],
  ['She-Hulk',91,['Super strength','Durability'],['Strength','Intelligence'],['Power varies by version'],'Jennifer Walters combines intelligence with superhuman abilities.','Powerful and versatile'],
  ['Wolverine',94,['Regeneration','Adamantium claws'],['Resilience','Senses','Combat experience'],['Magnetism-related vulnerability'],'Logan has a powerful healing factor and enhanced senses.','Close combat'],
  ['Deadpool',91,['Regeneration','Combat skills'],['Resilience','Improvisation'],['Unpredictability'],'Wade Wilson is known for regeneration and unconventional tactics.','Unpredictable'],
  ['Storm',94,['Weather manipulation','Flight'],['Area control','Range'],['Environmental dependence'],'Ororo Munroe can control weather.','Weather-based control'],
  ['Cyclops',88,['Optic blasts','Tactical leadership'],['Precision','Leadership'],['Needs control visor'],'Scott Summers is a tactical leader with optic energy beams.','Ranged precision'],
  ['Jean Grey',97,['Telepathy','Telekinesis'],['Mental abilities','Versatility'],['Power varies by version'],'Jean Grey is a powerful telepath and telekinetic.','Psychic abilities'],
  ['Beast',86,['Enhanced strength','Intelligence'],['Science','Agility'],['Limited ranged abilities'],'Hank McCoy combines scientific brilliance with enhanced physical abilities.','Intelligent and agile'],
  ['Rogue',91,['Power absorption','Flight in some versions'],['Adaptability','Strength'],['Touch-related limitations'],'Rogue can absorb powers and memories through touch.','Power adaptation'],
  ['Gambit',87,['Kinetic energy charging','Staff combat'],['Agility','Ranged attacks'],['Energy control limits'],'Remy LeBeau charges objects with kinetic energy.','Agile ranged combat'],
  ['Nightcrawler',88,['Teleportation','Agility'],['Mobility','Stealth'],['Teleportation limits'],'Kurt Wagner is a highly agile teleporter.','Teleportation'],
  ['Colossus',91,['Organic steel form','Strength'],['Durability','Strength'],['Reduced agility in metal form'],'Piotr Rasputin can transform his body into organic steel.','Durable strength'],
  ['Magneto',98,['Magnetism control','Force fields'],['Area control','Power'],['Non-metallic threats'],'Erik Lehnsherr controls magnetic fields.','Magnetic control'],
  ['Professor X',95,['Telepathy','Mental communication'],['Strategy','Mental abilities'],['Physical limitations'],'Charles Xavier is a powerful telepath and leader.','Psychic strategy'],
  ['Mystique',85,['Shapeshifting','Espionage'],['Infiltration','Deception'],['Limited direct power'],'Mystique can change her appearance.','Disguise and infiltration'],
  ['Apocalypse',98,['Molecular control','Super strength'],['Adaptability','Durability'],['Version-dependent limits'],'Apocalypse is an ancient mutant with extensive abilities.','Adaptive power'],
  ['Thanos',99,['Titan physiology','Cosmic knowledge'],['Strength','Durability','Strategy'],['Version-dependent equipment'],'Thanos is an immensely powerful Titan.','Cosmic strength'],
  ['Loki',94,['Magic','Illusions','Shapeshifting'],['Deception','Versatility'],['Magic limitations'],'Loki is a skilled sorcerer and trickster.','Illusion and magic'],
  ['Ultron',95,['Artificial intelligence','Robotic body','Energy weapons'],['Adaptability','Technology'],['Technology vulnerabilities'],'Ultron is an advanced artificial intelligence.','Technological'],
  ['Green Goblin',88,['Enhanced strength','Glider','Technology'],['Mobility','Technology'],['Unstable judgement'],'Norman Osborn uses advanced equipment and enhanced abilities.','Aerial technology'],
  ['Doctor Doom',98,['Science','Magic','Armour'],['Intelligence','Preparation','Versatility'],['Ego'],'Victor von Doom is a brilliant scientist and sorcerer.','Science and magic'],
  ['Venom',93,['Symbiote abilities','Strength','Regeneration'],['Adaptability','Strength'],['Symbiote-specific weaknesses'],'Venom is a powerful symbiote character.','Adaptive close combat'],
  ['Carnage',94,['Symbiote abilities','Shapeshifting'],['Adaptability','Power'],['Symbiote-specific weaknesses'],'Carnage is a dangerous symbiote with changing forms.','Unpredictable'],
  ['Star-Lord',85,['Technology','Marksmanship','Leadership'],['Tactics','Mobility'],['Equipment dependence'],'Peter Quill is a space adventurer and team leader.','Ranged and tactical'],
  ['Gamora',88,['Enhanced abilities','Swordsmanship'],['Agility','Technique'],['Limited ranged options'],'Gamora is a highly trained warrior.','Precise close combat'],
  ['Drax',87,['Strength','Durability'],['Resilience','Strength'],['Limited versatility'],'Drax is a powerful Guardian of the Galaxy.','Direct strength'],
  ['Rocket Raccoon',86,['Engineering','Weapons expertise'],['Technology','Improvisation'],['Small stature'],'Rocket is an inventive engineer and strategist.','Technology and tactics'],
  ['Groot',88,['Plant manipulation','Regeneration'],['Resilience','Adaptability'],['Growth-dependent limits'],'Groot is a tree-like hero with regenerative abilities.','Defensive and adaptive'],
  ['Silver Surfer',99,['Cosmic power','Flight','Energy manipulation'],['Speed','Power','Versatility'],['Cosmic responsibilities'],'The Silver Surfer wields the Power Cosmic.','Cosmic energy'],
  ['Ghost Rider',97,['Supernatural abilities','Hellfire','Regeneration'],['Resilience','Supernatural power'],['Supernatural rules vary'],'Ghost Rider is a supernatural antihero.','Supernatural']
];

const DC_DATA = [
  ['Batman',87,['Detective skills','Martial arts','Technology'],['Preparation','Strategy','Stealth'],['Human physiology'],'Bruce Wayne is a highly trained detective and strategist.','Strategic'],
  ['Superman',98,['Flight','Super strength','Heat vision'],['Speed','Durability','Power'],['Continuity-dependent vulnerabilities'],'Clark Kent is a Kryptonian with exceptional strength and speed.','High-power'],
  ['Wonder Woman',94,['Amazonian abilities','Combat skill','Lasso'],['Combat','Durability','Leadership'],['Continuity-dependent limits'],'Diana is an Amazonian warrior.','Disciplined close combat'],
  ['Flash',97,['Super speed','Time-related abilities'],['Speed','Reflexes'],['Speed Force rules vary'],'Barry Allen is a speedster hero.','High speed'],
  ['Aquaman',91,['Atlantean physiology','Ocean communication'],['Strength','Durability','Leadership'],['Environment-dependent advantages'],'Arthur Curry is the king of Atlantis.','Aquatic strength'],
  ['Green Lantern',96,['Power ring','Energy constructs'],['Versatility','Willpower'],['Ring charge and focus'],'Hal Jordan uses a power ring to create energy constructs.','Energy constructs'],
  ['Cyborg',91,['Cybernetics','Technology interface'],['Technology','Adaptability'],['System vulnerabilities'],'Victor Stone is a hero with advanced cybernetic abilities.','Technological'],
  ['Shazam',94,['Magic','Flight','Strength'],['Power','Durability'],['Magic-related rules'],'Billy Batson transforms into a powerful champion.','Magical strength'],
  ['Martian Manhunter',97,['Telepathy','Shapeshifting','Flight'],['Versatility','Mental abilities'],['Fire vulnerability in many versions'],'Jonn Jonzz is a powerful Martian hero.','Versatile'],
  ['Green Arrow',84,['Archery','Tactics'],['Precision','Planning'],['Human physiology'],'Oliver Queen is an expert archer.','Ranged precision'],
  ['Supergirl',96,['Kryptonian abilities','Flight'],['Strength','Speed','Durability'],['Continuity-dependent vulnerabilities'],'Kara Zor-El has Kryptonian abilities.','High-power'],
  ['Nightwing',87,['Acrobatics','Martial arts'],['Agility','Leadership'],['Human physiology'],'Dick Grayson is an expert acrobat and tactician.','Agile'],
  ['Red Hood',87,['Combat training','Technology'],['Tactics','Experience'],['Human physiology'],'Jason Todd is a highly trained vigilante.','Tactical'],
  ['Batgirl',85,['Martial arts','Technology','Detective skills'],['Intelligence','Agility'],['Human physiology'],'Barbara Gordon is a skilled hero and detective.','Technical'],
  ['Robin',82,['Martial arts','Acrobatics'],['Agility','Training'],['Human physiology'],'Robin is a trained young hero.','Agile'],
  ['Raven',95,['Magic','Empathy','Energy manipulation'],['Magic','Versatility'],['Emotional control'],'Raven is a powerful empath and magic user.','Mystical'],
  ['Starfire',93,['Energy projection','Flight','Strength'],['Power','Mobility'],['Power varies by version'],'Koriand\'r is a powerful alien hero.','Energy combat'],
  ['Beast Boy',87,['Animal transformation'],['Adaptability','Versatility'],['Form-dependent limits'],'Garfield Logan can transform into animals.','Adaptive'],
  ['Blue Beetle',90,['Alien scarab armour','Energy weapons'],['Technology','Adaptability'],['Scarab control'],'Jaime Reyes uses an advanced alien scarab.','Armoured technology'],
  ['Booster Gold',85,['Future technology','Force field'],['Technology','Mobility'],['Equipment dependence'],'Booster Gold uses technology from the future.','Technology'],
  ['Zatanna',95,['Magic','Spell casting'],['Versatility','Creativity'],['Concentration'],'Zatanna is a powerful stage magician and sorcerer.','Magic'],
  ['John Constantine',88,['Occult knowledge','Magic'],['Deception','Knowledge'],['Human durability'],'John Constantine is an expert in the occult.','Mystical strategy'],
  ['Doctor Fate',97,['Nabu magic','Cosmic awareness'],['Magic','Knowledge'],['Host and helmet limitations'],'Doctor Fate is a powerful magical champion.','Cosmic magic'],
  ['Black Adam',96,['Magic','Flight','Strength'],['Power','Durability'],['Magic-related limits'],'Black Adam possesses extraordinary magical powers.','High strength'],
  ['Lex Luthor',90,['Technology','Intelligence','Armour'],['Strategy','Science'],['Human physiology'],'Lex Luthor is a brilliant scientist and strategist.','Technology and planning'],
  ['Joker',83,['Planning','Psychology'],['Unpredictability','Deception'],['Human physiology'],'The Joker is an unpredictable criminal mastermind.','Psychological tactics'],
  ['Harley Quinn',84,['Acrobatics','Combat training'],['Agility','Improvisation'],['Human physiology'],'Harley Quinn is agile and unpredictable.','Acrobatic'],
  ['Deathstroke',91,['Enhanced physiology','Tactics','Weapons expertise'],['Strategy','Training'],['Human limitations'],'Slade Wilson is an expert tactician.','Strategic combat'],
  ['Bane',89,['Strength enhancement','Strategy'],['Strength','Planning'],['Enhancement dependence'],'Bane combines strength with strategic intelligence.','Power and tactics'],
  ['Darkseid',100,['Omega Effect','New God physiology'],['Power','Durability','Cosmic influence'],['Version-dependent limits'],'Darkseid is a powerful New God.','Cosmic power'],
  ['Doomsday',99,['Adaptation','Super strength'],['Durability','Strength'],['Adaptation varies'],'Doomsday is known for extraordinary adaptation.','Overwhelming strength'],
  ['Brainiac',97,['Advanced intellect','Technology'],['Intelligence','Technology'],['Technology vulnerabilities'],'Brainiac is a highly advanced artificial intelligence.','Strategic technology'],
  ['Reverse-Flash',97,['Super speed','Time manipulation'],['Speed','Knowledge'],['Speed Force rules'],'Eobard Thawne is a powerful speedster.','High speed'],
  ['Black Manta',87,['Armour','Technology','Underwater combat'],['Technology','Tactics'],['Equipment dependence'],'Black Manta is an advanced underwater combatant.','Armoured'],
  ['Sinestro',95,['Power ring','Energy constructs'],['Willpower','Strategy'],['Ring dependence'],'Sinestro wields a powerful energy ring.','Energy constructs'],
  ['Hawkman',90,['Flight','Nth metal','Combat training'],['Experience','Mobility'],['Equipment dependence'],'Hawkman is an experienced warrior.','Aerial combat'],
  ['Hawkgirl',90,['Flight','Nth metal','Combat training'],['Agility','Experience'],['Equipment dependence'],'Hawkgirl is a skilled aerial warrior.','Aerial combat'],
  ['Plastic Man',92,['Elasticity','Shapeshifting'],['Adaptability','Resilience'],['Power limitations vary'],'Plastic Man can reshape his body.','Adaptive'],
  ['Firestorm',96,['Matter manipulation','Energy control'],['Versatility','Power'],['Coordination requirements'],'Firestorm can manipulate matter and energy.','Energy and matter control'],
  ['Blue Devil',86,['Supernatural strength','Trident'],['Strength','Durability'],['Supernatural limitations'],'Blue Devil has supernatural abilities.','Supernatural'],
  ['The Atom',86,['Size manipulation','Science'],['Precision','Intelligence'],['Technology dependence'],'The Atom can change his size.','Size-based strategy'],
  ['Vixen',89,['Animal ability mimicry'],['Adaptability','Versatility'],['Totem dependence'],'Vixen can access animal abilities.','Adaptive'],
  ['Static',88,['Electromagnetism','Flight'],['Energy control','Mobility'],['Power control limits'],'Static controls electromagnetic energy.','Energy control'],
  ['Superboy',93,['Kryptonian abilities','Telekinesis in some versions'],['Strength','Adaptability'],['Version-dependent abilities'],'Superboy has powers derived from Kryptonian heritage.','High-power'],
  ['Power Girl',95,['Kryptonian abilities','Flight'],['Strength','Durability'],['Continuity-dependent vulnerabilities'],'Power Girl is a powerful Kryptonian hero.','High-power'],
  ['Mister Miracle',88,['Escape artistry','Technology'],['Ingenuity','Adaptability'],['Human limits'],'Mister Miracle is a master escape artist.','Ingenuity'],
  ['Big Barda',94,['New God physiology','Mega-Rod'],['Strength','Combat experience'],['Equipment dependence'],'Big Barda is a powerful New God warrior.','Powerful close combat'],
  ['Orion',96,['New God physiology','Astro-Harness'],['Strength','Durability'],['Temperamental nature'],'Orion is a powerful New God warrior.','Cosmic strength'],
  ['Etrigan',94,['Demonic abilities','Magic'],['Strength','Magic'],['Supernatural rules'],'Etrigan is a powerful supernatural being.','Supernatural'],
  ['Ra\'s al Ghul',87,['Martial arts','Strategy','Lazarus Pit'],['Planning','Experience'],['Human limitations'],'Ra\'s al Ghul is an experienced strategist and fighter.','Strategic']
];

function makePermanentPool(genre, data) {
  return data.map(([name, rating, abilities, strengths, weaknesses, description, style]) =>
    makeCharacter(genre, name, rating, abilities, strengths, weaknesses, description, style)
  );
}

const MARVEL_CHARACTERS = makePermanentPool('Marvel', MARVEL_DATA);
const DC_CHARACTERS = makePermanentPool('DC', DC_DATA);

// --------------------------------------------------
// RAMAYANA AND MAHABHARATA DATABASES
// --------------------------------------------------

const EPIC_CHARACTERS = {
  Ramayana: [
    ['Rama',98,'Prince of Ayodhya and skilled warrior and archer'],
    ['Lakshmana',94,'Brother of Rama and powerful warrior'],
    ['Bharata',88,'Brother of Rama and warrior prince'],
    ['Shatrughna',87,'Brother of Rama and warrior prince'],
    ['Hanuman',99,'Powerful Vanara warrior with extraordinary strength'],
    ['Ravana',98,'King of Lanka and formidable warrior'],
    ['Kumbhakarna',95,'Powerful warrior and brother of Ravana'],
    ['Indrajit',97,'Son of Ravana and master of celestial weapons'],
    ['Vibhishana',87,'Brother of Ravana who fought alongside Rama'],
    ['Sugriva',90,'Vanara king and warrior ally of Rama'],
    ['Vali',96,'Extremely powerful Vanara warrior and king'],
    ['Angada',91,'Son of Vali and skilled Vanara warrior'],
    ['Jambavan',92,'Experienced warrior and leader of the bear army'],
    ['Jatayu',86,'Warrior bird who fought to protect Sita'],
    ['Garuda',98,'Divine warrior bird with immense power'],
    ['Maricha',85,'Rakshasa warrior with magical abilities'],
    ['Subahu',83,'Rakshasa warrior who fought against Rama'],
    ['Tataka',85,'Powerful Rakshasi warrior'],
    ['Nala',87,'Vanara warrior and bridge builder'],
    ['Nila',87,'Vanara warrior and commander'],
    ['Prahasta',91,'Chief commander of Ravana’s army'],
    ['Akampana',85,'Rakshasa warrior in Ravana’s army'],
    ['Atikaya',92,'Powerful son of Ravana and warrior'],
    ['Narantaka',87,'Son of Ravana and warrior'],
    ['Devantaka',88,'Son of Ravana and powerful fighter'],
    ['Trishira',87,'Three-headed warrior in Ravana’s army'],
    ['Mahodara',85,'Rakshasa commander of Lanka'],
    ['Mahaparshva',85,'Rakshasa warrior and commander'],
    ['Dhumraksha',86,'Rakshasa general in Ravana’s army'],
    ['Vajradamshtra',86,'Powerful Rakshasa warrior'],
    ['Kumbha',89,'Son of Kumbhakarna and warrior of Lanka'],
    ['Nikumbha',88,'Son of Kumbhakarna and Rakshasa warrior'],
    ['Mainda',85,'Vanara warrior in Rama’s army'],
    ['Dvivida',86,'Vanara warrior and commander'],
    ['Gavaksha',84,'Vanara commander in Rama’s army'],
    ['Gaja',84,'Vanara warrior and commander'],
    ['Rishabha',84,'Vanara warrior who fought in Lanka'],
    ['Sushena',85,'Vanara commander and warrior'],
    ['Makaraksha',87,'Son of Khara and Rakshasa warrior'],
    ['Virupaksha',84,'Rakshasa warrior of Lanka']
  ],
  Mahabharata: [
    ['Krishna',100,'Strategist and guide who played a key role in the war'],
    ['Arjuna',99,'Legendary archer and one of the greatest warriors'],
    ['Karna',98,'Legendary archer and formidable warrior'],
    ['Bhishma',99,'Grand commander and master of warfare'],
    ['Drona',97,'Master of archery and military strategy'],
    ['Ashwatthama',96,'Powerful warrior and son of Drona'],
    ['Bhima',97,'Pandava warrior known for immense strength'],
    ['Yudhishthira',91,'Pandava warrior and skilled fighter'],
    ['Nakula',90,'Pandava warrior skilled in swordsmanship'],
    ['Sahadeva',90,'Pandava warrior and skilled fighter'],
    ['Duryodhana',96,'Kaurava leader and master of mace fighting'],
    ['Dushasana',88,'Kaurava warrior and brother of Duryodhana'],
    ['Abhimanyu',96,'Young warrior renowned for entering the Chakravyuha'],
    ['Ghatotkacha',96,'Powerful warrior and son of Bhima'],
    ['Balarama',97,'Master of mace fighting and powerful warrior'],
    ['Satyaki',93,'Skilled Yadava warrior allied with the Pandavas'],
    ['Kripacharya',94,'Experienced warrior and master of weapons'],
    ['Shikhandi',90,'Warrior who played a key role against Bhishma'],
    ['Dhrishtadyumna',94,'Commander of the Pandava army'],
    ['Parashurama',100,'Legendary warrior and master of weapons'],
    ['Ekalavya',94,'Exceptional archer known for his dedication'],
    ['Jayadratha',89,'King and warrior who fought for the Kauravas'],
    ['Barbarika',99,'Legendary warrior with extraordinary archery skills'],
    ['Uttara Kumara',85,'Prince and warrior of the Matsya kingdom'],
    ['Virata',88,'King of Matsya and warrior'],
    ['Drupada',90,'King of Panchala and experienced warrior'],
    ['Pandu',89,'Father of the Pandavas and skilled archer'],
    ['Somadatta',87,'Kuru-side warrior'],
    ['Bhagadatta',94,'King and elephant-warrior who fought for the Kauravas'],
    ['Shalya',93,'King of Madra and powerful warrior'],
    ['Kritavarma',91,'Yadava warrior who fought for the Kauravas'],
    ['Bhurishravas',91,'Experienced Kuru-side warrior'],
    ['Vikarna',86,'Kaurava warrior and brother of Duryodhana'],
    ['Alambusha',90,'Rakshasa warrior who fought in the Kurukshetra war'],
    ['Bahlika',88,'Elder Kuru warrior and king'],
    ['Sudakshina',87,'King of Kamboja and warrior'],
    ['Brihadbala',88,'King of Kosala who fought in the war'],
    ['Susharma',88,'King of Trigarta and warrior'],
    ['Chekitana',89,'Warrior who fought on the Pandava side'],
    ['Yuyutsu',85,'Kaurava brother who fought for the Pandavas']
  ]
};

function makeEpicSeedCharacters(genre) {
  return EPIC_CHARACTERS[genre].map(([name, rating, description]) =>
    makeCharacter(
      genre,
      name,
      rating,
      ['Traditional epic combat abilities', 'Warfare and strategy'],
      ['Experience', 'Courage', 'Combat skill'],
      ['Depends on the version and interpretation'],
      description,
      'Traditional epic warrior'
    )
  );
}

// --------------------------------------------------
// CHARACTER DATABASE ACCESS
// --------------------------------------------------

async function generateGenreCharacters(genre) {
  if (genre === 'Marvel') return clone(MARVEL_CHARACTERS);
  if (genre === 'DC') return clone(DC_CHARACTERS);
  if (genre === 'Ramayana' || genre === 'Mahabharata') {
    return makeEpicSeedCharacters(genre);
  }

  if (!process.env.GEMINI_API_KEY) {
    throw new Error(`Gemini API key is required to generate ${genre} characters.`);
  }

  const generated = [];
  const seen = new Set();

  for (let batch = 0; batch < 5 && generated.length < 100; batch++) {
    const count = Math.min(20, 100 - generated.length);
    const existingNames = generated.map(c => c.name).join(', ');

    const prompt = `
Generate ${count} established and distinct characters from "${genre}".
Do not repeat: ${existingNames}
Use established characters only. Do not invent characters.
For Football and Cricket, use real established players.
For Harry Potter and Anime, use established characters from their respective works.
Return JSON only:
{
 "characters": [
  {
   "name":"Name","version":"Version","rating":85,
   "abilities":["Ability"],"strengths":["Strength"],
   "weaknesses":["Weakness"],"description":"Description",
   "combatStyle":"Style"
  }
 ]
}`;

    let entries;

    try {
      const parsed = await generateJSON(prompt, `${genre} batch ${batch + 1}`, value => {
        if (!value || !Array.isArray(value.characters)) {
          throw new Error('Gemini did not return a characters array.');
        }
        return value;
      });
      entries = parsed.characters;
    } catch (error) {
      if (error instanceof GeminiQuotaError) throw error;
      // Keep what we already have if a later batch fails.
      if (generated.length >= 20) {
        console.warn(`${genre}: stopping early with ${generated.length} characters.`, error.message);
        break;
      }
      throw error;
    }

    for (const raw of entries) {
      const character = normalizeCharacter(raw, genre);
      if (!character) continue;

      const key = slugify(character.name);
      if (seen.has(key)) continue;

      seen.add(key);
      generated.push(character);
    }

    if (!entries.length) break;
  }

  if (generated.length < 10) {
    throw new Error(`${genre} produced only ${generated.length} characters.`);
  }

  return generated.slice(0, 100);
}

// The promise is cached immediately so simultaneous requests for the same
// genre share one generation instead of each calling Gemini.
function getGenreCharacters(genre) {
  if (!GENRES.includes(genre)) {
    return Promise.reject(new Error(`Unsupported genre: ${genre}`));
  }

  if (genreCache.has(genre)) return genreCache.get(genre);

  const promise = generateGenreCharacters(genre).catch(error => {
    genreCache.delete(genre);
    throw error;
  });

  genreCache.set(genre, promise);
  return promise;
}

// --------------------------------------------------
// CHARACTER IMAGE LOOKUP (WIKIPEDIA)
// --------------------------------------------------

function normalizeImageText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

async function getWikipediaImage(character) {
  const cacheKey = `${character.universe}:${character.name}`.toLowerCase();

  if (imageCache.has(cacheKey)) {
    return imageCache.get(cacheKey);
  }

  const promise = (async () => {
    try {
      const searchUrl = new URL('https://en.wikipedia.org/w/api.php');

      searchUrl.searchParams.set('action', 'query');
      searchUrl.searchParams.set('list', 'search');
      searchUrl.searchParams.set('srsearch', `"${character.name}" ${character.universe}`);
      searchUrl.searchParams.set('srnamespace', '0');
      searchUrl.searchParams.set('srlimit', '10');
      searchUrl.searchParams.set('format', 'json');
      searchUrl.searchParams.set('origin', '*');

      const searchResponse = await fetch(searchUrl, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'BattleAuctionGame/1.0 (character image lookup)' }
      });

      if (!searchResponse.ok) return null;

      const searchData = await searchResponse.json();
      const results = searchData.query?.search || [];

      if (!results.length) return null;

      const characterName = normalizeImageText(character.name);
      const genreName = normalizeImageText(character.universe);

      // Whole-word matching, so "Rama" does not match "Ramayana".
      const paddedName = ` ${characterName} `;

      const rankedResults = results
        .map(page => {
          const title = normalizeImageText(page.title);
          const paddedTitle = ` ${title} `;

          let score = 0;

          if (title === characterName) {
            score = 100;
          } else if (title.startsWith(characterName + ' ')) {
            score = 90;
          } else if (paddedTitle.includes(paddedName)) {
            score = 75;
          }

          if (score && genreName && title.includes(genreName)) {
            score += 10;
          }

          return { page, score };
        })
        .filter(item => item.score >= 75)
        .sort((a, b) => b.score - a.score);

      if (!rankedResults.length) return null;

      const pageIds = rankedResults
        .slice(0, 5)
        .map(item => item.page.pageid)
        .join('|');

      const imageUrl = new URL('https://en.wikipedia.org/w/api.php');

      imageUrl.searchParams.set('action', 'query');
      imageUrl.searchParams.set('pageids', pageIds);
      imageUrl.searchParams.set('prop', 'pageimages');
      imageUrl.searchParams.set('piprop', 'thumbnail');
      imageUrl.searchParams.set('pithumbsize', '700');
      imageUrl.searchParams.set('format', 'json');
      imageUrl.searchParams.set('origin', '*');

      const imageResponse = await fetch(imageUrl, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'BattleAuctionGame/1.0 (character image lookup)' }
      });

      if (!imageResponse.ok) return null;

      const imageData = await imageResponse.json();
      const pages = imageData.query?.pages || {};

      for (const item of rankedResults) {
        const page = pages[item.page.pageid];

        if (page?.thumbnail?.source) {
          return page.thumbnail.source;
        }
      }

      return null;
    } catch (error) {
      console.warn(`Image lookup failed for ${character.name}:`, error.message);
      return null;
    }
  })();

  imageCache.set(cacheKey, promise);

  return promise;
}

async function attachCharacterImages(room) {
  let nextIndex = 0;

  const workerCount = Math.min(5, room.characters.length);

  async function worker() {
    while (nextIndex < room.characters.length) {
      if (!rooms.has(room.code)) return;

      const index = nextIndex++;
      const character = room.characters[index];

      try {
        character.imageUrl = await getWikipediaImage(character);
      } catch {
        character.imageUrl = null;
      }

      // Batched: at most one broadcast per second instead of one per image.
      scheduleEmit(room);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

// --------------------------------------------------
// ROOM STATE
// --------------------------------------------------

const REVEAL_ALL_STATUSES = [
  'team_reveal',
  'ready_for_fight',
  'championship',
  'incomplete'
];

function publicRoom(room, viewerId) {
  const showAllTeams = REVEAL_ALL_STATUSES.includes(room.status);

  // Image URLs are always looked up from the room's master character list,
  // so teams and the current character stay up to date as images load.
  const imageById = new Map(
    room.characters.map(character => [character.id, character.imageUrl || null])
  );

  const withImage = character => {
    if (!character) return null;

    return {
      ...character,
      imageUrl: imageById.get(character.id) ?? character.imageUrl ?? null
    };
  };

  const connectedPlayers = room.players.filter(p => p.connected);

  const currentTurnIndex = connectedPlayers.findIndex(
    p => p.id === room.currentTurnPlayerId
  );

  // Only characters that have already been deployed are sent during the
  // auction, so clients cannot see the upcoming order.
  const visibleCharacters = showAllTeams
    ? room.characters
    : room.characters.slice(0, Math.max(0, room.characterIndex + 1));

  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    settings: room.settings,

    players: room.players.map(player => ({
      id: player.id,
      name: player.name,
      budget: player.budget,
      team: showAllTeams || player.id === viewerId
        ? player.team.map(withImage)
        : [],
      connected: player.connected
    })),

    characters: visibleCharacters.map(withImage),
    totalCharacters: room.characters.length,
    characterIndex: room.characterIndex,
    currentCharacter: withImage(room.currentCharacter),
    currentBid: room.currentBid,
    highestBidderId: room.highestBidderId,
    lastBidderId: room.lastBidderId,
    currentTurnPlayerId: room.currentTurnPlayerId,
    currentTurnIndex: Math.max(0, currentTurnIndex),
    turnDeadline: room.turnDeadline,
    noIncreaseTurns: room.noIncreaseTurns,
    openingPlayerId: room.openingPlayerId,
    nextOpeningPlayerId: room.nextOpeningPlayerId,
    auctionLog: room.auctionLog,
    results: room.results,
    championship: room.championship,
    reserveCount: room.reserveCharacters.length,
    completionError: room.completionError,
    stateVersion: room.stateVersion || 0,
    serverTime: Date.now()
  };
}

function emitRoom(room) {
  room.stateVersion = (room.stateVersion || 0) + 1;

  for (const player of room.players) {
    if (!player.connected) continue;
    io.to(player.id).emit('room:update', publicRoom(room, player.id));
  }
}

function scheduleEmit(room, delay = 1000) {
  if (emitTimers.has(room.code)) return;

  const timer = setTimeout(() => {
    emitTimers.delete(room.code);
    if (rooms.has(room.code)) emitRoom(room);
  }, delay);

  emitTimers.set(room.code, timer);
}

function stopTimer(code) {
  const timer = turnTimers.get(code);
  if (timer) clearTimeout(timer);
  turnTimers.delete(code);
}

function destroyRoom(code) {
  stopTimer(code);

  const reveal = revealTimers.get(code);
  if (reveal) clearTimeout(reveal);
  revealTimers.delete(code);

  const pending = emitTimers.get(code);
  if (pending) clearTimeout(pending);
  emitTimers.delete(code);

  rooms.delete(code);
}

function activePlayers(room) {
  return room.players.filter(player => player.connected);
}

function findRoomForSocket(socketId) {
  return [...rooms.values()].find(room =>
    room.players.some(player => player.id === socketId)
  );
}

function getHostRoom(socket) {
  return [...rooms.values()].find(room => room.hostId === socket.id);
}

function findPlayer(room, playerId) {
  return room.players.find(player => player.id === playerId);
}

function canBid(player, room) {
  return Boolean(
    player &&
    player.connected &&
    player.team.length < room.settings.teamSize &&
    player.budget >= room.currentBid + 1
  );
}

function transferHostIfNeeded(room) {
  const host = findPlayer(room, room.hostId);
  if (host && host.connected) return;

  const next = room.players.find(player => player.connected);
  if (next) room.hostId = next.id;
}

// When a player reconnects they get a new socket id. This swaps the old id
// for the new one everywhere in the room so their seat, team and bids carry on.
function remapPlayerId(room, oldId, newId) {
  if (oldId === newId) return;

  const swap = value => (value === oldId ? newId : value);

  const player = findPlayer(room, oldId);
  if (player) player.id = newId;

  room.hostId = swap(room.hostId);
  room.openingPlayerId = swap(room.openingPlayerId);
  room.nextOpeningPlayerId = swap(room.nextOpeningPlayerId);
  room.currentTurnPlayerId = swap(room.currentTurnPlayerId);
  room.highestBidderId = swap(room.highestBidderId);
  room.lastBidderId = swap(room.lastBidderId);

  if (room.passedPlayerIds.has(oldId)) {
    room.passedPlayerIds.delete(oldId);
    room.passedPlayerIds.add(newId);
  }

  for (const result of room.results) {
    result.winnerId = swap(result.winnerId);
  }

  for (const entry of room.auctionLog) {
    if ('playerId' in entry) entry.playerId = swap(entry.playerId);
    if ('winnerId' in entry) entry.winnerId = swap(entry.winnerId);
  }

  if (room.championship) {
    for (const match of room.championship.matches || []) {
      match.teamAId = swap(match.teamAId);
      match.teamBId = swap(match.teamBId);
      match.winnerId = swap(match.winnerId);
    }

    for (const standing of room.championship.standings || []) {
      standing.playerId = swap(standing.playerId);
    }
  }
}

// --------------------------------------------------
// AUCTION TURN MANAGEMENT
// --------------------------------------------------

function getNextEligiblePlayer(room, afterPlayerId) {
  const players = room.players;
  if (!players.length) return null;

  const startIndex = players.findIndex(p => p.id === afterPlayerId);

  for (let step = 1; step <= players.length; step++) {
    const index = (Math.max(startIndex, -1) + step) % players.length;
    const player = players[index];

    if (!player.connected) continue;
    if (player.id === room.highestBidderId) continue;
    if (room.passedPlayerIds.has(player.id)) continue;
    if (!canBid(player, room)) continue;

    return player;
  }

  return null;
}

function finishTurnCycle(room) {
  if (room.status !== 'auction') return;

  const nextPlayer = getNextEligiblePlayer(room, room.currentTurnPlayerId);

  if (!nextPlayer) {
    resolveAuction(room);
    return;
  }

  room.currentTurnPlayerId = nextPlayer.id;
  beginTurn(room);
}

function pauseAuction(room) {
  stopTimer(room.code);
  room.turnDeadline = null;
  room.status = 'auction_paused';
  emitRoom(room);
}

function beginTurn(room) {
  stopTimer(room.code);
  if (room.status !== 'auction') return;

  if (!activePlayers(room).length) {
    pauseAuction(room);
    return;
  }

  let currentPlayer = findPlayer(room, room.currentTurnPlayerId);

  const eligible =
    currentPlayer &&
    currentPlayer.connected &&
    currentPlayer.id !== room.highestBidderId &&
    !room.passedPlayerIds.has(currentPlayer.id) &&
    canBid(currentPlayer, room);

  if (!eligible) currentPlayer = getNextEligiblePlayer(room, room.currentTurnPlayerId);

  if (!currentPlayer) {
    resolveAuction(room);
    return;
  }

  room.currentTurnPlayerId = currentPlayer.id;
  room.turnDeadline = Date.now() + room.settings.turnSeconds * 1000;
  room.turnToken = (room.turnToken || 0) + 1;

  const token = room.turnToken;
  const deadline = room.turnDeadline;

  emitRoom(room);

  const timer = setTimeout(() => {
    const currentRoom = rooms.get(room.code);
    if (!currentRoom || currentRoom.status !== 'auction') return;
    if (currentRoom.turnToken !== token) return;
    if (currentRoom.turnDeadline !== deadline) return;
    passTurn(currentRoom, 'TIMEOUT');
  }, room.settings.turnSeconds * 1000 + 100);

  turnTimers.set(room.code, timer);
}

function passTurn(room, reason = 'SKIP') {
  if (room.status !== 'auction') return;

  stopTimer(room.code);

  const player = findPlayer(room, room.currentTurnPlayerId);
  if (player) room.passedPlayerIds.add(player.id);

  room.noIncreaseTurns = room.passedPlayerIds.size;
  room.auctionLog.push({
    type: reason,
    playerId: player?.id || null,
    at: Date.now()
  });

  room.turnDeadline = null;
  finishTurnCycle(room);
}

// --------------------------------------------------
// RESOLVE CURRENT AUCTION
// --------------------------------------------------

function resolveAuction(room) {
  if (room.status !== 'auction' || !room.currentCharacter) return;

  stopTimer(room.code);

  const character = clone(room.currentCharacter);
  const winner = findPlayer(room, room.lastBidderId);

  let awarded = false;

  // A winner who is briefly disconnected still keeps their winning bid.
  if (
    winner &&
    winner.budget >= room.currentBid &&
    winner.team.length < room.settings.teamSize
  ) {
    winner.budget -= room.currentBid;
    winner.team.push({ ...character, paid: room.currentBid });

    room.results.push({
      characterId: character.id,
      characterName: character.name,
      winnerId: winner.id,
      winnerName: winner.name,
      amount: room.currentBid
    });

    awarded = true;
  }

  if (!awarded) {
    room.reserveCharacters.push(character);
    room.results.push({
      characterId: character.id,
      characterName: character.name,
      winnerId: null,
      winnerName: null,
      amount: 0
    });
  }

  room.auctionLog.push({
    type: 'RESOLVED',
    characterId: character.id,
    winnerId: awarded ? winner.id : null,
    at: Date.now()
  });

  room.nextOpeningPlayerId = awarded
    ? winner.id
    : (room.openingPlayerId || room.hostId);

  room.currentCharacter = null;
  room.turnDeadline = null;
  room.currentTurnPlayerId = null;
  room.currentBid = room.settings.startingBid;
  room.highestBidderId = null;
  room.lastBidderId = null;
  room.noIncreaseTurns = 0;
  room.passedPlayerIds = new Set();
  room.currentTurnIndex = 0;
  room.status = 'auction_ready';

  const allTeamsFull = room.players.every(
    player => player.team.length >= room.settings.teamSize
  );

  if (room.characterIndex >= room.characters.length - 1 || allTeamsFull) {
    completeAuction(room);
    return;
  }

  emitRoom(room);
}

// --------------------------------------------------
// FREE CHARACTER ALLOCATION
// --------------------------------------------------

function completeAuction(room) {
  if (room.status !== 'auction_ready' && room.status !== 'auction') return;

  stopTimer(room.code);

  // One entry per empty slot. (The old version looped forever here.)
  const emptySlots = [];

  for (const player of room.players) {
    for (let i = player.team.length; i < room.settings.teamSize; i++) {
      emptySlots.push(player);
    }
  }

  const assignedIds = new Set(
    room.players.flatMap(player => player.team.map(character => character.id))
  );

  // First priority: characters nobody bought. Second: any other unused ones.
  const heldCharacters = room.reserveCharacters.filter(
    character => !assignedIds.has(character.id)
  );

  const heldIds = new Set(heldCharacters.map(c => c.id));

  const remainingCharacters = room.characters.filter(
    character => !assignedIds.has(character.id) && !heldIds.has(character.id)
  );

  // Shuffled so the host and early joiners get no advantage.
  const freePool = [
    ...shuffle(heldCharacters),
    ...shuffle(remainingCharacters)
  ];

  if (freePool.length < emptySlots.length) {
    room.status = 'incomplete';
    room.currentCharacter = null;
    room.turnDeadline = null;

    room.completionError =
      `Not enough unused characters. ${emptySlots.length} slots are empty, but only ${freePool.length} characters remain.`;

    emitRoom(room);
    return;
  }

  shuffle(emptySlots).forEach((player, index) => {
    player.team.push({
      ...clone(freePool[index]),
      paid: 0,
      allocatedFree: true
    });
  });

  room.reserveCharacters = freePool.slice(emptySlots.length);

  room.currentCharacter = null;
  room.turnDeadline = null;
  room.currentTurnPlayerId = null;
  room.completionError = null;
  room.status = 'team_reveal';

  emitRoom(room);

  const oldTimer = revealTimers.get(room.code);
  if (oldTimer) clearTimeout(oldTimer);

  const timer = setTimeout(() => {
    const currentRoom = rooms.get(room.code);

    if (!currentRoom || currentRoom.status !== 'team_reveal') return;

    currentRoom.status = 'ready_for_fight';

    revealTimers.delete(room.code);
    emitRoom(currentRoom);
  }, 10000);

  revealTimers.set(room.code, timer);
}

// --------------------------------------------------
// TEAM STRENGTH AND COMBINED STANDINGS
// --------------------------------------------------

function calculateTeamStrength(team) {
  if (!team.length) return 0;

  const ratings = team.reduce(
    (total, character) => total + Number(character.rating || 0),
    0
  );

  const strengths = new Set(team.flatMap(character => character.strengths || []));
  const abilities = new Set(team.flatMap(character => character.abilities || []));

  const synergy = Math.min(
    5,
    Math.floor((strengths.size + abilities.size) / team.length)
  );

  return Math.max(0, Math.min(100, Math.round(ratings / team.length + synergy)));
}

function isSpecialMatch(playerA, playerB, scoreA, scoreB) {
  if (scoreA === scoreB) return true;
  if (Math.abs(scoreA - scoreB) <= 3) return true;

  const averageRating = team => {
    if (!team.length) return 0;

    return team.reduce(
      (total, character) => total + Number(character.rating || 0),
      0
    ) / team.length;
  };

  const ratingA = averageRating(playerA.team);
  const ratingB = averageRating(playerB.team);

  if (scoreA > scoreB && ratingB - ratingA >= 8) return true;
  if (scoreB > scoreA && ratingA - ratingB >= 8) return true;

  return false;
}

function calculateStandings(room, matches, evaluations = []) {
  const evaluationMap = new Map(
    evaluations.map(evaluation => [evaluation.playerId, evaluation])
  );

  const maxMatchPoints = Math.max(1, 3 * (room.players.length - 1));

  const standings = room.players.map(player => {
    const played = matches.filter(match =>
      match.teamAId === player.id || match.teamBId === player.id
    );

    const wins = played.filter(match => match.winnerId === player.id).length;
    const draws = played.filter(match => match.result === 'DRAW').length;
    const losses = played.length - wins - draws;
    const points = wins * 3 + draws;

    const scoreDifference = played.reduce((total, match) => {
      return total + (
        match.teamAId === player.id
          ? match.scoreA - match.scoreB
          : match.scoreB - match.scoreA
      );
    }, 0);

    const evaluation = evaluationMap.get(player.id);
    const teamEvaluationScore = Number(
      evaluation?.score ?? calculateTeamStrength(player.team)
    );

    const normalizedMatchScore = (points / maxMatchPoints) * 100;
    const combinedScore = Math.round(
      normalizedMatchScore * 0.70 + teamEvaluationScore * 0.30
    );

    return {
      playerId: player.id,
      name: player.name,
      wins,
      draws,
      losses,
      points,
      scoreDifference,
      teamStrength: teamEvaluationScore,
      normalizedMatchScore: Number(normalizedMatchScore.toFixed(2)),
      combinedScore,
      aiSummary: evaluation?.summary || '',
      strengths: evaluation?.strengths || [],
      weaknesses: evaluation?.weaknesses || [],
      synergy: evaluation?.synergy || '',
      balance: evaluation?.balance || '',
      vulnerabilities: evaluation?.vulnerabilities || [],
      keyContributions: evaluation?.keyContributions || [],
      rankingRationale: evaluation?.rankingRationale || '',
      team: player.team
    };
  });

  standings.sort((a, b) =>
    b.combinedScore - a.combinedScore ||
    b.points - a.points ||
    b.wins - a.wins ||
    b.scoreDifference - a.scoreDifference ||
    b.teamStrength - a.teamStrength
  );

  let previousKey = null;
  let rank = 0;

  standings.forEach((standing, index) => {
    const key = [
      standing.combinedScore,
      standing.points,
      standing.wins,
      standing.scoreDifference,
      standing.teamStrength
    ].join(':');

    if (key !== previousKey) rank = index + 1;
    standing.rank = rank;
    previousKey = key;
  });

  return standings;
}

// --------------------------------------------------
// LOCAL FALLBACK ANALYSIS
// --------------------------------------------------

function buildCharacterAnalysis(team, opponentTeam) {
  return team.map(character => {
    const advantages = [
      ...(character.strengths || []),
      ...(character.abilities || [])
    ].slice(0, 5);

    const disadvantages = (character.weaknesses || []).slice(0, 5);

    return {
      characterName: character.name,
      opponentMatchups: opponentTeam.map(opponent => ({
        opponentName: opponent.name,
        advantage: advantages[0]
          ? `${character.name} may benefit from ${advantages[0]}.`
          : 'No specific advantage was supplied.',
        disadvantage: disadvantages[0]
          ? `${character.name} has the listed limitation: ${disadvantages[0]}.`
          : 'No specific weakness was supplied.',
        impact: `Provisional profile-based comparison with ${opponent.name}.`
      })),
      advantages: advantages.length ? advantages : ['No specific advantage supplied.'],
      disadvantages: disadvantages.length ? disadvantages : ['No specific weakness supplied.'],
      impact: character.description || 'Contribution based on the character profile.',
      tacticalRole: character.combatStyle || 'Role not specified.'
    };
  });
}

function sanitizeCharacterAnalysis(entries, team, opponentTeam) {
  const teamNames = new Set(team.map(character => character.name));
  const opponentNames = new Set(opponentTeam.map(character => character.name));

  if (!Array.isArray(entries)) {
    return buildCharacterAnalysis(team, opponentTeam);
  }

  const byName = new Map();

  for (const entry of entries) {
    if (!entry || !teamNames.has(entry.characterName)) continue;

    const opponentMatchups = Array.isArray(entry.opponentMatchups)
      ? entry.opponentMatchups
          .filter(item => item && opponentNames.has(item.opponentName))
          .map(item => ({
            opponentName: safeText(item.opponentName),
            advantage: safeText(item.advantage),
            disadvantage: safeText(item.disadvantage),
            impact: safeText(item.impact)
          }))
      : [];

    byName.set(entry.characterName, {
      characterName: entry.characterName,
      opponentMatchups,
      advantages: cleanList(entry.advantages),
      disadvantages: cleanList(entry.disadvantages),
      impact: safeText(entry.impact),
      tacticalRole: safeText(entry.tacticalRole)
    });
  }

  return team.map(character =>
    byName.get(character.name) || buildCharacterAnalysis([character], opponentTeam)[0]
  );
}

function fallbackEvaluation(player) {
  return {
    playerId: player.id,
    score: calculateTeamStrength(player.team),
    summary: 'Provisional evaluation based on character ratings and team attributes.',
    strengths: [],
    weaknesses: [],
    synergy: 'Fallback calculation; detailed Gemini analysis was unavailable.',
    balance: 'Based on available character ratings.',
    vulnerabilities: [],
    keyContributions: [],
    rankingRationale: 'Provisional ranking using the combined scoring formula.'
  };
}

function buildMatchResult(room, playerA, playerB, scoreA, scoreB) {
  let winnerId = null;
  let result = 'DRAW';

  if (scoreA > scoreB) {
    winnerId = playerA.id;
    result = 'TEAM_A_WINS';
  } else if (scoreB > scoreA) {
    winnerId = playerB.id;
    result = 'TEAM_B_WINS';
  }

  return { winnerId, result };
}

function buildFallbackMatch(room, playerA, playerB) {
  const scoreA = calculateTeamStrength(playerA.team);
  const scoreB = calculateTeamStrength(playerB.team);
  const { winnerId, result } = buildMatchResult(room, playerA, playerB, scoreA, scoreB);

  return {
    teamAId: playerA.id,
    teamAName: playerA.name,
    teamBId: playerB.id,
    teamBName: playerB.name,
    scoreA,
    scoreB,
    winnerId,
    result,
    explanation: isSpecialMatch(playerA, playerB, scoreA, scoreB)
      ? `${playerA.name} scored ${scoreA}/100 and ${playerB.name} scored ${scoreB}/100. This is a special match because ${
          scoreA === scoreB
            ? 'the result is a draw.'
            : Math.abs(scoreA - scoreB) <= 3
              ? 'the result was exceptionally close.'
              : 'the winning team had a lower average character rating.'
        }`
      : '',
    analysisStatus: 'fallback'
  };
}

function createFallbackChampionship(room, errorMessage) {
  const matches = [];

  for (let i = 0; i < room.players.length; i++) {
    for (let j = i + 1; j < room.players.length; j++) {
      matches.push(buildFallbackMatch(room, room.players[i], room.players[j]));
    }
  }

  const evaluations = room.players.map(fallbackEvaluation);

  return {
    matches,
    standings: calculateStandings(room, matches, evaluations),
    totalMatches: matches.length,
    completedAt: Date.now(),
    overallSummary:
      'Gemini could not complete the detailed evaluation. These are provisional results based on character ratings and team attributes.',
    rankingExplanation:
      'The combined formula is applied, but the team-evaluation component uses the fallback calculation.',
    aiEvaluation: {
      provider: 'Gemini',
      status: 'unavailable',
      message: safeText(errorMessage, 'Gemini evaluation failed.')
    },
    rankingRules: [
      'Combined score = 70% normalized head-to-head match points + 30% team evaluation.',
      'Match win: 3 points',
      'Match draw: 1 point',
      'Match loss: 0 points',
      'Tiebreakers: combined score, match points, wins, score difference, team evaluation score.',
      'Fallback team evaluation uses character ratings and team attributes.'
    ]
  };
}

// --------------------------------------------------
// AI TEAM EVALUATION
// --------------------------------------------------

async function evaluateTeamsWithGemini(teams) {
  const prompt = `
You are a neutral judge for a fictional and sporting team-building championship.

Evaluate every team using only the supplied information.
Consider team composition, role diversity, balance, strengths, weaknesses and synergy.
Do not invent abilities or achievements.
For fictional characters, keep analysis non-graphic and focused on fictional abilities and strategy.
Do not automatically favour famous characters.
Scores must be integers from 1 to 100.
Return every team exactly once.

Return JSON only:
{
 "teams":[
  {
   "playerId":"EXACT_ID",
   "score":90,
   "summary":"Short team evaluation",
   "strengths":["Strength"],
   "weaknesses":["Weakness"],
   "synergy":"Team synergy",
   "balance":"Team balance",
   "vulnerabilities":["Vulnerability"],
   "keyContributions":[
    {"characterName":"Exact character name","contribution":"Specific contribution"}
   ],
   "rankingRationale":"Reason for score"
  }
 ]
}

TEAMS:
${JSON.stringify(teams)}
`;

  const parsed = await generateJSON(prompt, 'Team evaluation', value => {
    if (!value || !Array.isArray(value.teams)) {
      throw new Error('Gemini did not return a teams array.');
    }
    return value;
  });

  const validIds = new Set(teams.map(team => team.playerId));
  const seen = new Set();
  const evaluations = [];

  for (const entry of parsed.teams) {
    if (!entry || !validIds.has(entry.playerId) || seen.has(entry.playerId)) continue;

    const score = Number(entry.score);
    if (!Number.isFinite(score)) continue;

    seen.add(entry.playerId);

    evaluations.push({
      playerId: entry.playerId,
      score: Math.max(1, Math.min(100, Math.round(score))),
      summary: safeText(entry.summary),
      strengths: cleanList(entry.strengths),
      weaknesses: cleanList(entry.weaknesses),
      synergy: safeText(entry.synergy),
      balance: safeText(entry.balance),
      vulnerabilities: cleanList(entry.vulnerabilities),
      keyContributions: Array.isArray(entry.keyContributions)
        ? entry.keyContributions.slice(0, 20).map(item => ({
            characterName: safeText(item?.characterName, 'Team member'),
            contribution: safeText(item?.contribution, 'Not specified')
          }))
        : [],
      rankingRationale: safeText(entry.rankingRationale)
    });
  }

  if (!evaluations.length) {
    throw new Error('Gemini returned no usable team evaluations.');
  }

  return evaluations;
}

// --------------------------------------------------
// AI HEAD-TO-HEAD MATCHUPS IN BATCHES
// --------------------------------------------------

async function evaluateMatchupBatch(batch) {
  const prompt = `
You are a neutral judge comparing teams in a fictional and sporting team-building championship.

Evaluate every matchup in this batch.
Use only the supplied character information.
Do not invent powers, skills, achievements or weaknesses.
Consider team balance, role diversity, synergy and how each character contributes against the opposing team.
Include individual character contribution analysis for BOTH teams.
If a team has more than 6 characters, return an empty opponentMatchups array for each character to keep the response short.
For fictional characters, keep the analysis non-graphic and focused on abilities and strategy.
For Football and Cricket, focus on sporting ability, roles and team balance.
Scores must be integers from 1 to 100.
A higher score wins. Equal scores mean a draw.
Use the EXACT teamAId and teamBId given for each matchup, and do not swap the teams.
Return every matchup exactly once.

Return JSON only:
{
 "matchups":[
  {
   "teamAId":"EXACT_ID",
   "teamBId":"EXACT_ID",
   "scoreA":85,
   "scoreB":80,
   "explanation":"Why these scores were given",
   "teamAAnalysis":[
    {
     "characterName":"Exact character name",
     "advantages":["Specific advantage against this opponent"],
     "disadvantages":["Relevant limitation"],
     "impact":"What this character contributes in this matchup",
     "tacticalRole":"Role in this matchup",
     "opponentMatchups":[
      {
       "opponentName":"Exact opposing character",
       "advantage":"Specific matchup advantage",
       "disadvantage":"Specific matchup limitation",
       "impact":"Short matchup assessment"
      }
     ]
    }
   ],
   "teamBAnalysis":[
    {
     "characterName":"Exact character name",
     "advantages":["Specific advantage"],
     "disadvantages":["Relevant limitation"],
     "impact":"Contribution",
     "tacticalRole":"Role",
     "opponentMatchups":[
      {
       "opponentName":"Exact opposing character",
       "advantage":"Specific advantage",
       "disadvantage":"Specific limitation",
       "impact":"Short matchup assessment"
      }
     ]
    }
   ]
  }
 ]
}

MATCHUPS:
${JSON.stringify(batch)}
`;

  const parsed = await generateJSON(prompt, 'Matchup batch', value => {
    if (!value || !Array.isArray(value.matchups)) {
      throw new Error('Gemini did not return a matchups array.');
    }
    return value;
  });

  return parsed.matchups;
}

// --------------------------------------------------
// COMPLETE GEMINI CHAMPIONSHIP
// --------------------------------------------------

async function evaluateChampionshipWithGemini(room) {
  getGeminiClient(); // throws early with a clear message if the key is missing

  const teams = room.players.map(player => ({
    playerId: player.id,
    playerName: player.name,
    characters: player.team.map(character => ({
      name: character.name,
      genre: character.universe,
      version: character.version,
      rating: character.rating,
      abilities: character.abilities || [],
      strengths: character.strengths || [],
      weaknesses: character.weaknesses || [],
      description: character.description || '',
      style: character.combatStyle || ''
    }))
  }));

  // 1) One overall evaluation per team. Missing teams get a local fallback.
  let evaluations = [];

  try {
    evaluations = await evaluateTeamsWithGemini(teams);
  } catch (error) {
    if (error instanceof GeminiQuotaError) throw error;
    console.warn('Team evaluation failed, using fallback:', error.message);
  }

  const evaluationMap = new Map(
    evaluations.map(evaluation => [evaluation.playerId, evaluation])
  );

  let fallbackEvaluations = 0;

  for (const player of room.players) {
    if (!evaluationMap.has(player.id)) {
      evaluationMap.set(player.id, fallbackEvaluation(player));
      fallbackEvaluations++;
    }
  }

  const allEvaluations = [...evaluationMap.values()];

  // 2) Every unique pair of teams.
  const allPairs = [];

  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      allPairs.push({
        teamA: teams[i],
        teamB: teams[j],
        teamAId: teams[i].playerId,
        teamBId: teams[j].playerId
      });
    }
  }

  // Bigger teams make bigger responses, so use smaller batches.
  const teamSize = room.settings.teamSize;
  const batchSize = teamSize <= 3 ? 5 : teamSize <= 6 ? 3 : 1;

  const batches = [];
  for (let i = 0; i < allPairs.length; i += batchSize) {
    batches.push(allPairs.slice(i, i + batchSize));
  }

  async function runBatch(batch) {
    try {
      const returned = await evaluateMatchupBatch(
        batch.map(pair => ({
          teamAId: pair.teamAId,
          teamBId: pair.teamBId,
          teamA: pair.teamA,
          teamB: pair.teamB
        }))
      );

      return { batch, returned };
    } catch (error) {
      if (error instanceof GeminiQuotaError) throw error;
      console.warn('Matchup batch failed, using fallback for it:', error.message);
      return { batch, returned: [] };
    }
  }

  function buildAiMatch(pair, entry) {
    const playerA = findPlayer(room, pair.teamAId);
    const playerB = findPlayer(room, pair.teamBId);

    // Accept the teams in either order and swap back if needed.
    const swapped = entry.teamAId === pair.teamBId;

    const rawScoreA = Number(swapped ? entry.scoreB : entry.scoreA);
    const rawScoreB = Number(swapped ? entry.scoreA : entry.scoreB);

    if (!Number.isFinite(rawScoreA) || !Number.isFinite(rawScoreB)) return null;

    const scoreA = Math.max(1, Math.min(100, Math.round(rawScoreA)));
    const scoreB = Math.max(1, Math.min(100, Math.round(rawScoreB)));

    const { winnerId, result } = buildMatchResult(room, playerA, playerB, scoreA, scoreB);

    return {
      teamAId: pair.teamAId,
      teamAName: playerA.name,
      teamBId: pair.teamBId,
      teamBName: playerB.name,
      scoreA,
      scoreB,
      winnerId,
      result,
      explanation: isSpecialMatch(playerA, playerB, scoreA, scoreB)
        ? safeText(
            entry.explanation,
            `${playerA.name}: ${scoreA}/100. ${playerB.name}: ${scoreB}/100.`
          )
        : '',
      teamAAnalysis: sanitizeCharacterAnalysis(
        swapped ? entry.teamBAnalysis : entry.teamAAnalysis,
        playerA.team,
        playerB.team
      ),
      teamBAnalysis: sanitizeCharacterAnalysis(
        swapped ? entry.teamAAnalysis : entry.teamBAnalysis,
        playerB.team,
        playerA.team
      ),
      analysisStatus: 'complete'
    };
  }

  const allMatches = [];
  let fallbackMatches = 0;
  const concurrency = 3;

  for (let start = 0; start < batches.length; start += concurrency) {
    const group = batches.slice(start, start + concurrency);
    const results = await Promise.all(group.map(runBatch));

    for (const { batch, returned } of results) {
      for (const pair of batch) {
        const entry = returned.find(item =>
          item && (
            (item.teamAId === pair.teamAId && item.teamBId === pair.teamBId) ||
            (item.teamAId === pair.teamBId && item.teamBId === pair.teamAId)
          )
        );

        const aiMatch = entry ? buildAiMatch(pair, entry) : null;

        if (aiMatch) {
          allMatches.push(aiMatch);
        } else {
          allMatches.push(
            buildFallbackMatch(
              room,
              findPlayer(room, pair.teamAId),
              findPlayer(room, pair.teamBId)
            )
          );
          fallbackMatches++;
        }
      }
    }

    console.log(
      `Gemini matchup batches ${Math.min(start + concurrency, batches.length)}/${batches.length} completed`
    );
  }

  const standings = calculateStandings(room, allMatches, allEvaluations);
  const partial = fallbackMatches > 0 || fallbackEvaluations > 0;

  return {
    matches: allMatches,
    standings,
    totalMatches: allMatches.length,
    completedAt: Date.now(),
    overallSummary: partial
      ? 'Gemini evaluated most of the championship. Some parts used a rating-based fallback.'
      : 'Gemini evaluated every team and every head-to-head matchup, including individual character contributions.',
    rankingExplanation:
      'Final ranking combines 70% normalized head-to-head match points and 30% overall team evaluation.',
    aiEvaluation: {
      provider: 'Gemini',
      status: partial ? 'partial' : 'complete',
      message: partial
        ? `Gemini evaluated ${teams.length - fallbackEvaluations} of ${teams.length} teams and ${allMatches.length - fallbackMatches} of ${allMatches.length} matchups. The rest used a rating-based fallback.`
        : `Gemini evaluated ${teams.length} teams and ${allMatches.length} head-to-head matchups in ${batches.length + 1} requests. Character contributions and opposing-character matchups were AI evaluated.`
    },
    rankingRules: [
      '70% of the final score comes from normalized head-to-head match points.',
      '30% of the final score comes from the overall team evaluation.',
      'Match win: 3 points',
      'Match draw: 1 point',
      'Match loss: 0 points',
      'Tiebreakers: combined score, match points, wins, score difference, team evaluation score.'
    ]
  };
}

// --------------------------------------------------
// START CHAMPIONSHIP
// --------------------------------------------------

async function startChampionship(room) {
  if (room.status !== 'ready_for_fight') return;

  const incompletePlayer = room.players.find(
    player => player.team.length !== room.settings.teamSize
  );

  if (incompletePlayer) return;

  room.status = 'championship';
  room.championship = {
    matches: [],
    standings: [],
    totalMatches: 0,
    completedAt: null,
    overallSummary: 'Evaluating every team and matchup...',
    rankingExplanation:
      'The final ranking combines head-to-head results and overall team evaluation.',
    aiEvaluation: {
      provider: 'Gemini',
      status: 'evaluating',
      message: 'Championship evaluation is in progress.'
    },
    rankingRules: []
  };

  emitRoom(room);

  try {
    const evaluation = await evaluateChampionshipWithGemini(room);
    if (!rooms.has(room.code)) return;

    room.championship = evaluation;
    emitRoom(room);
    console.log(`Championship completed for room ${room.code}`);
  } catch (error) {
    console.error('Gemini championship evaluation failed:', error);
    if (!rooms.has(room.code)) return;

    room.championship = createFallbackChampionship(room, error.message);
    emitRoom(room);
  }
}

// --------------------------------------------------
// HOST VALIDATION
// --------------------------------------------------

function isHost(room, socket) {
  if (!room || room.hostId !== socket.id) {
    socket.emit('error:message', 'Only the host can perform this action.');
    return false;
  }
  return true;
}

// --------------------------------------------------
// API ROUTES
// --------------------------------------------------

// Simple per-IP rate limit for /api (60 requests per minute).
const apiHits = new Map();

app.use('/api', (req, res, next) => {
  const now = Date.now();
  const record = apiHits.get(req.ip) || { start: now, count: 0 };

  if (now - record.start > 60000) {
    record.start = now;
    record.count = 0;
  }

  record.count++;
  apiHits.set(req.ip, record);

  if (record.count > 60) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }

  next();
});

setInterval(() => {
  const cutoff = Date.now() - 120000;
  for (const [ip, record] of apiHits) {
    if (record.start < cutoff) apiHits.delete(ip);
  }
}, 300000);

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'BATTLE AUCTION',
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    geminiModel: resolveModelName()
  });
});

app.get('/api/universes', (_req, res) => {
  res.json(GENRES);
});

app.post('/api/research', async (req, res) => {
  const genre = String(req.body?.universe || '').trim();

  if (!GENRES.includes(genre)) {
    return res.status(400).json({ error: 'Choose a supported genre.' });
  }

  try {
    const characters = await getGenreCharacters(genre);
    res.json({
      note: 'Marvel, DC, Ramayana and Mahabharata use permanent curated databases. Other genres use Gemini-generated pools.',
      count: characters.length,
      characters
    });
  } catch (error) {
    res.status(502).json({
      error: 'Character database loading failed.',
      detail: error.message
    });
  }
});

// --------------------------------------------------
// SOCKET.IO EVENTS
// --------------------------------------------------

io.on('connection', socket => {

  // Basic flood protection: at most 60 events per 10 seconds per socket.
  let windowStart = Date.now();
  let eventCount = 0;

  socket.use((_packet, next) => {
    const now = Date.now();

    if (now - windowStart > 10000) {
      windowStart = now;
      eventCount = 0;
    }

    if (++eventCount > 60) {
      socket.emit('error:message', 'Too many requests. Please slow down.');
      return;
    }

    next();
  });

  // CREATE ROOM
  socket.on('room:create', ({ name } = {}) => {
    if (findRoomForSocket(socket.id)) {
      return socket.emit('error:message', 'You are already in a room.');
    }

    if (rooms.size >= 500) {
      return socket.emit('error:message', 'The server is busy. Please try again later.');
    }

    let code;
    do {
      code = roomCode();
    } while (rooms.has(code));

    const player = {
      id: socket.id,
      key: crypto.randomBytes(16).toString('hex'),
      name: cleanName(name, 'Host'),
      budget: STARTING_BUDGET,
      team: [],
      connected: true
    };

    // Settings are fixed by the server. Client-supplied settings are ignored
    // here; the host chooses team size, timer, bid and genres in room:start.
    const room = {
      code,
      hostId: socket.id,
      status: 'lobby',
      settings: {
        startingBudget: STARTING_BUDGET,
        teamSize: 3,
        turnSeconds: 10,
        startingBid: 1,
        universes: ['Marvel', 'DC']
      },
      players: [player],
      characters: [],
      characterIndex: -1,
      currentCharacter: null,
      currentBid: 1,
      highestBidderId: null,
      lastBidderId: null,
      currentTurnIndex: 0,
      currentTurnPlayerId: null,
      openingPlayerId: socket.id,
      nextOpeningPlayerId: socket.id,
      turnDeadline: null,
      turnToken: 0,
      noIncreaseTurns: 0,
      passedPlayerIds: new Set(),
      auctionLog: [],
      results: [],
      reserveCharacters: [],
      championship: null,
      completionError: null,
      emptySince: null,
      stateVersion: 0
    };

    rooms.set(code, room);
    socket.join(code);
    socket.emit('session', { code, key: player.key });
    socket.emit('room:created', publicRoom(room, socket.id));
    emitRoom(room);
  });

  // JOIN ROOM
  socket.on('room:join', ({ code, name } = {}) => {
    if (findRoomForSocket(socket.id)) {
      return socket.emit('error:message', 'You are already in a room.');
    }

    const room = rooms.get(String(code || '').toUpperCase());

    if (!room || room.status !== 'lobby') {
      return socket.emit('error:message', 'Room not found or game already started.');
    }

    if (room.players.length >= MAX_PLAYERS) {
      return socket.emit('error:message', 'Room is full.');
    }

    const player = {
      id: socket.id,
      key: crypto.randomBytes(16).toString('hex'),
      name: cleanName(name, 'Player'),
      budget: room.settings.startingBudget,
      team: [],
      connected: true
    };

    room.players.push(player);
    socket.join(room.code);
    socket.emit('session', { code: room.code, key: player.key });
    socket.emit('room:joined', publicRoom(room, socket.id));
    emitRoom(room);
  });

  // REJOIN AFTER A DISCONNECT OR PAGE REFRESH
  // The client should store { code, key } from the 'session' event and send
  // it here when the socket reconnects.
  socket.on('room:rejoin', ({ code, key } = {}) => {
    const room = rooms.get(String(code || '').toUpperCase());
    const player = room && key
      ? room.players.find(p => p.key === String(key))
      : null;

    if (!room || !player) {
      return socket.emit('room:rejoin-failed', 'Could not rejoin. The room may have expired.');
    }

    const oldId = player.id;

    if (oldId !== socket.id) {
      // Move the seat to the new socket, then drop the stale socket if any.
      remapPlayerId(room, oldId, socket.id);

      const oldSocket = io.sockets.sockets.get(oldId);
      if (oldSocket) oldSocket.disconnect(true);
    }

    player.connected = true;
    room.emptySince = null;
    socket.join(room.code);
    socket.emit('session', { code: room.code, key: player.key });
    socket.emit('room:joined', publicRoom(room, socket.id));

    transferHostIfNeeded(room);

    if (room.status === 'auction_paused') {
      room.status = 'auction';
      beginTurn(room);
    } else {
      emitRoom(room);
    }
  });

  // START GAME
  socket.on('room:start', async ({
    universes,
    teamSize,
    turnSeconds,
    startingBid
  } = {}) => {
    const room = getHostRoom(socket);
    if (!room || room.status !== 'lobby') return;

    if (room.players.length < 2) {
      return socket.emit('error:message', 'At least two players are required.');
    }

    const parsedTeamSize = Number(teamSize);
    const parsedTurnSeconds = Number(turnSeconds);
    const parsedStartingBid = Number(startingBid);

    if (!Number.isInteger(parsedTeamSize) || parsedTeamSize < 1 || parsedTeamSize > 20) {
      return socket.emit('error:message', 'Team size must be between 1 and 20.');
    }

    if (!Number.isInteger(parsedTurnSeconds) || parsedTurnSeconds < 5 || parsedTurnSeconds > 120) {
      return socket.emit('error:message', 'Turn duration must be between 5 and 120 seconds.');
    }

    if (
      !Number.isInteger(parsedStartingBid) ||
      parsedStartingBid < 1 ||
      parsedStartingBid >= room.settings.startingBudget
    ) {
      return socket.emit(
        'error:message',
        'Starting bid must be a positive whole number below the starting budget.'
      );
    }

    const selectedGenres =
      Array.isArray(universes) && universes.length
        ? [...new Set(universes.filter(value => GENRES.includes(value)))]
        : room.settings.universes.filter(value => GENRES.includes(value));

    if (!selectedGenres.length) {
      return socket.emit('error:message', 'Choose at least one available genre.');
    }

    const needsGemini = selectedGenres.some(
      genre => !['Ramayana', 'Mahabharata', 'Marvel', 'DC'].includes(genre)
    );

    if (needsGemini && !process.env.GEMINI_API_KEY) {
      return socket.emit(
        'error:message',
        'A Gemini API key is required for Football, Cricket, Harry Potter or Anime. The four curated universes do not require Gemini to load.'
      );
    }

    const requiredCharacters = room.players.length * parsedTeamSize;

    room.status = 'loading_characters';
    room.completionError = null;
    emitRoom(room);

    try {
      const genrePools = [];

      for (const genre of selectedGenres) {
        const characters = await getGenreCharacters(genre);
        genrePools.push(...characters);
      }

      if (!rooms.has(room.code)) return;

      const uniqueCharacters = [];
      const seenIds = new Set();

      for (const character of genrePools) {
        if (seenIds.has(character.id)) continue;
        seenIds.add(character.id);
        uniqueCharacters.push(character);
      }

      if (uniqueCharacters.length < requiredCharacters) {
        room.status = 'lobby';
        socket.emit(
          'error:message',
          `Not enough characters. You need ${requiredCharacters}, but only ${uniqueCharacters.length} unique characters are available. Choose more genres or reduce team size.`
        );
        emitRoom(room);
        return;
      }

      // Copies, so rooms never share (or modify) the cached character objects.
      room.characters = shuffle(uniqueCharacters)
        .slice(0, requiredCharacters)
        .map(character => ({ ...character }));

      room.settings.teamSize = parsedTeamSize;
      room.settings.turnSeconds = parsedTurnSeconds;
      room.settings.startingBid = parsedStartingBid;
      room.settings.universes = selectedGenres;
      room.settings.characterCount = requiredCharacters;

      room.players.forEach(player => {
        player.budget = room.settings.startingBudget;
        player.team = [];
      });

      room.characterIndex = -1;
      room.currentCharacter = null;
      room.currentBid = parsedStartingBid;
      room.highestBidderId = null;
      room.lastBidderId = null;
      room.currentTurnIndex = 0;
      room.currentTurnPlayerId = null;
      room.openingPlayerId = room.hostId;
      room.nextOpeningPlayerId = room.hostId;
      room.turnDeadline = null;
      room.turnToken = 0;
      room.noIncreaseTurns = 0;
      room.passedPlayerIds = new Set();
      room.auctionLog = [];
      room.results = [];
      room.reserveCharacters = [];
      room.championship = null;
      room.completionError = null;
      room.status = 'auction_ready';

      emitRoom(room);

      attachCharacterImages(room).catch(error => {
        console.warn('Background image loading failed:', error.message);
      });

    } catch (error) {
      console.error('Character database loading failed:', error);

      if (!rooms.has(room.code)) return;

      room.status = 'lobby';

      socket.emit(
        'error:message',
        `Character database loading failed: ${error.message}`
      );

      emitRoom(room);
    }
  });

  // HOST DEPLOYS NEXT RANDOM CHARACTER
  socket.on('auction:next-character', () => {
    const room = getHostRoom(socket);
    if (!isHost(room, socket)) return;

    if (room.status !== 'auction_ready') {
      return socket.emit('error:message', 'The next character is not ready yet.');
    }

    if (room.characterIndex + 1 >= room.characters.length) {
      return completeAuction(room);
    }

    room.characterIndex++;
    room.currentCharacter = clone(room.characters[room.characterIndex]);
    room.currentBid = room.settings.startingBid;
    room.highestBidderId = null;
    room.lastBidderId = null;
    room.noIncreaseTurns = 0;
    room.passedPlayerIds = new Set();
    room.openingPlayerId = room.nextOpeningPlayerId || room.hostId;

    let openingPlayer = findPlayer(room, room.openingPlayerId);

    if (!openingPlayer || !openingPlayer.connected || !canBid(openingPlayer, room)) {
      openingPlayer = room.players.find(player =>
        player.connected && canBid(player, room)
      );
    }

    room.currentTurnPlayerId = openingPlayer?.id || null;
    room.turnDeadline = null;
    room.status = 'auction';

    beginTurn(room);
  });

  // INCREASE BID
  socket.on('bid:increase', ({ amount } = {}) => {
    const room = findRoomForSocket(socket.id);
    if (!room || room.status !== 'auction') return;

    if (room.currentTurnPlayerId !== socket.id) {
      return socket.emit('error:message', 'It is not your turn.');
    }

    if (!room.turnDeadline || Date.now() > room.turnDeadline) {
      return socket.emit('error:message', 'Your turn has expired.');
    }

    const player = findPlayer(room, socket.id);
    const increment = Number(amount);

    if (!Number.isInteger(increment) || increment < 1) {
      return socket.emit('error:message', 'Enter a whole-number increase of at least ₹1.');
    }

    if (player.team.length >= room.settings.teamSize) {
      return socket.emit('error:message', 'Your team is full.');
    }

    const newBid = room.currentBid + increment;

    if (newBid > player.budget) {
      return socket.emit('error:message', 'That bid exceeds your remaining budget.');
    }

    stopTimer(room.code);

    room.currentBid = newBid;
    room.highestBidderId = player.id;
    room.lastBidderId = player.id;
    room.passedPlayerIds = new Set([player.id]);
    room.noIncreaseTurns = 0;

    room.auctionLog.push({
      type: 'BID',
      playerId: player.id,
      amount: newBid,
      increment,
      at: Date.now()
    });

    room.turnDeadline = null;
    finishTurnCycle(room);
  });

  // SKIP TURN
  socket.on('bid:skip', () => {
    const room = findRoomForSocket(socket.id);
    if (!room || room.status !== 'auction') return;

    if (room.currentTurnPlayerId !== socket.id) {
      return socket.emit('error:message', 'It is not your turn.');
    }

    if (!room.turnDeadline || Date.now() > room.turnDeadline) {
      return socket.emit('error:message', 'Your turn has expired.');
    }

    passTurn(room, 'SKIP');
  });

  // HOST STARTS CHAMPIONSHIP
  socket.on('championship:start', async () => {
    const room = getHostRoom(socket);
    if (!isHost(room, socket)) return;

    if (room.status !== 'ready_for_fight') {
      return socket.emit('error:message', 'The teams are not ready for the championship.');
    }

    const incompletePlayer = room.players.find(
      player => player.team.length !== room.settings.teamSize
    );

    if (incompletePlayer) {
      return socket.emit(
        'error:message',
        `${incompletePlayer.name}'s team is not complete.`
      );
    }

    await startChampionship(room);
  });

  // PLAYER DISCONNECT
  socket.on('disconnect', () => {
    const room = findRoomForSocket(socket.id);
    if (!room) return;

    const player = findPlayer(room, socket.id);
    if (!player) return;

    // In the lobby a leaving player is simply removed.
    if (room.status === 'lobby') {
      room.players = room.players.filter(p => p.id !== socket.id);

      if (!room.players.length) {
        destroyRoom(room.code);
        return;
      }

      if (room.hostId === socket.id) {
        room.hostId = room.players[0].id;
        room.openingPlayerId = room.hostId;
        room.nextOpeningPlayerId = room.hostId;
      }

      emitRoom(room);
      return;
    }

    // After the game starts the seat is kept so the player can rejoin.
    player.connected = false;
    transferHostIfNeeded(room);

    if (!activePlayers(room).length) {
      room.emptySince = Date.now();

      if (room.status === 'auction') {
        pauseAuction(room);
      }

      return;
    }

    if (room.status === 'auction' && room.currentTurnPlayerId === socket.id) {
      passTurn(room, 'SKIP');
      return;
    }

    emitRoom(room);
  });
});

// --------------------------------------------------
// CLEAN UP ABANDONED ROOMS
// --------------------------------------------------

setInterval(() => {
  const now = Date.now();

  for (const room of [...rooms.values()]) {
    if (
      !activePlayers(room).length &&
      room.emptySince &&
      now - room.emptySince > ROOM_IDLE_MS
    ) {
      console.log(`Removing abandoned room ${room.code}`);
      destroyRoom(room.code);
    }
  }
}, 60000);

// --------------------------------------------------
// SERVE FRONTEND
// --------------------------------------------------

app.use(express.static(path.join(__dirname, '..', 'dist')));

app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();

  res.sendFile(
    path.join(__dirname, '..', 'dist', 'index.html'),
    error => {
      if (error) next(error);
    }
  );
});

// --------------------------------------------------
// SAFETY NETS AND START
// --------------------------------------------------

process.on('unhandledRejection', error => {
  console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error);
});

server.listen(PORT, () => {
  console.log(`BATTLE AUCTION server listening on ${PORT}`);
});
