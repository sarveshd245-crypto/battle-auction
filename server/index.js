
import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import { GoogleGenerativeAI } from '@google/generative-ai';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const rooms = new Map();
const turnTimers = new Map();
const revealTimers = new Map();
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

function getGeminiModel() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('Gemini API key is missing. Add GEMINI_API_KEY in Render.');
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  return genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.3
    }
  });
}

async function generateWithRetry(model, prompt, label = 'Gemini') {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await model.generateContent(prompt);
    } catch (error) {
      lastError = error;
      const message = String(error.message || '').toLowerCase();

      const quotaExhausted =
        message.includes('quota') ||
        message.includes('resource_exhausted') ||
        message.includes('billing') ||
        message.includes('limit: 0') ||
        message.includes('429');

      if (quotaExhausted) {
        throw new Error(
          `${label}: Gemini quota is exhausted. Check Google AI Studio usage and billing.`
        );
      }

      if (attempt < 3) {
        const delay = attempt * 2500;
        console.warn(`${label} attempt ${attempt} failed. Retrying in ${delay}ms.`);
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
  ['Black Panther',89,['Enhanced physiology','Vibranium suit'],['Strategy','Agility','Technology'],['Equipment dependence'],'T Challa is the technologically advanced king of Wakanda.','Agile and tactical'],
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
  ['Starfire',93,['Energy projection','Flight','Strength'],['Power','Mobility'],['Power varies by version'],'Koriand r is a powerful alien hero.','Energy combat'],
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
  ['Ras al Ghul',87,['Martial arts','Strategy','Lazarus Pit'],['Planning','Experience'],['Human limitations'],'Ra al Ghul is an experienced strategist and fighter.','Strategic']
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
  const model = getGeminiModel();

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

    const result = await generateWithRetry(model, prompt, `${genre} batch ${batch + 1}`);
    const parsed = extractJSON(result.response.text());
    const entries = Array.isArray(parsed.characters) ? parsed.characters : [];

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

async function getGenreCharacters(genre) {
  if (!GENRES.includes(genre)) throw new Error(`Unsupported genre: ${genre}`);

  if (genreCache.has(genre)) return genreCache.get(genre);

  const promise = generateGenreCharacters(genre);

  try {
    const characters = await promise;
    genreCache.set(genre, Promise.resolve(characters));
    return characters;
  } catch (error) {
    genreCache.delete(genre);
    throw error;
  }
}

// --------------------------------------------------
// CHARACTER IMAGE LOOKUP
// --------------------------------------------------

async function getWikipediaImage(character) {
  const cacheKey = `${character.universe}:${character.name}`.toLowerCase();
  if (imageCache.has(cacheKey)) return imageCache.get(cacheKey);

  const promise = (async () => {
    try {
      const url = new URL('https://en.wikipedia.org/w/api.php');
      url.searchParams.set('action', 'query');
      url.searchParams.set('generator', 'search');
      url.searchParams.set('gsrsearch', `${character.name} ${character.universe}`);
      url.searchParams.set('gsrnamespace', '0');
      url.searchParams.set('gsrlimit', '5');
      url.searchParams.set('prop', 'pageimages');
      url.searchParams.set('piprop', 'thumbnail');
      url.searchParams.set('pithumbsize', '700');
      url.searchParams.set('format', 'json');

      const response = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'BattleAuctionGame/1.0' }
      });

      if (!response.ok) return null;

      const data = await response.json();
      const pages = Object.values(data.query?.pages || {});
      if (!pages.length) return null;

      const name = character.name.toLowerCase();
      const best = pages.find(p =>
        String(p.title || '').toLowerCase().includes(name)
      ) || pages[0];

      return best.thumbnail?.source || null;
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
      const index = nextIndex++;
      room.characters[index].imageUrl =
        await getWikipediaImage(room.characters[index]);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (rooms.has(room.code)) emitRoom(room);
}

// --------------------------------------------------
// ROOM STATE
// --------------------------------------------------

function publicRoom(room, viewerId) {
  const showAllTeams = [
    'team_reveal',
    'ready_for_fight',
    'championship'
  ].includes(room.status);

  const showImages = [
    'auction_ready',
    'auction'
  ].includes(room.status);

  const publicCharacter = character => {
    if (!character) return null;

    const copy = { ...character };

    if (!showImages) {
      delete copy.imageUrl;
    }

    return copy;
  };

  const connectedPlayers = room.players.filter(p => p.connected);

  const currentTurnIndex = connectedPlayers.findIndex(
    p => p.id === room.currentTurnPlayerId
  );

  const currentCharacter = room.currentCharacter
    ? (
        room.characters.find(c => c.id === room.currentCharacter.id) ||
        room.currentCharacter
      )
    : null;

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
        ? player.team.map(publicCharacter)
        : [],
      connected: player.connected
    })),

    characters: room.characters.map(publicCharacter),
    characterIndex: room.characterIndex,
    currentCharacter: publicCharacter(currentCharacter),
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
    io.to(player.id).emit('room:update', publicRoom(room, player.id));
  }
}

function stopTimer(code) {
  const timer = turnTimers.get(code);
  if (timer) clearTimeout(timer);
  turnTimers.delete(code);
}

function activePlayers(room) {
  return room.players.filter(player => player.connected);
}

function findRoomForSocket(socketId) {
  return [...rooms.values()].find(room =>
    room.players.some(player => player.id === socketId)
  );
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

function beginTurn(room) {
  stopTimer(room.code);
  if (room.status !== 'auction') return;

  if (!activePlayers(room).length) {
    room.turnDeadline = null;
    room.currentTurnPlayerId = null;
    room.status = 'auction_paused';
    emitRoom(room);
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

  if (
    winner &&
    winner.connected &&
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

  if (room.characterIndex >= room.characters.length - 1) {
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

  const emptySlots = [];

  for (const player of room.players) {
    while (player.team.length < room.settings.teamSize) {
      emptySlots.push(player);
    }
  }

  const assignedIds = new Set(
    room.players.flatMap(player =>
      player.team.map(character => character.id)
    )
  );

  // First priority: characters held because nobody bought them.
  const heldCharacters = room.reserveCharacters.filter(
    character => !assignedIds.has(character.id)
  );

  const heldIds = new Set(heldCharacters.map(c => c.id));

  // Second priority: any other unused characters.
  const remainingCharacters = room.characters.filter(
    character =>
      !assignedIds.has(character.id) &&
      !heldIds.has(character.id)
  );

  const freePool = [
    ...heldCharacters,
    ...remainingCharacters
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

  emptySlots.forEach((player, index) => {
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
// LOCAL FALLBACK CHARACTER ANALYSIS
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

// --------------------------------------------------
// FALLBACK CHAMPIONSHIP
// --------------------------------------------------

function createFallbackChampionship(room, errorMessage) {
  const matches = [];

  for (let i = 0; i < room.players.length; i++) {
    for (let j = i + 1; j < room.players.length; j++) {
      const a = room.players[i];
      const b = room.players[j];

      const scoreA = calculateTeamStrength(a.team);
      const scoreB = calculateTeamStrength(b.team);

      let winnerId = null;
      let result = 'DRAW';

      if (scoreA > scoreB) {
        winnerId = a.id;
        result = 'TEAM_A_WINS';
      } else if (scoreB > scoreA) {
        winnerId = b.id;
        result = 'TEAM_B_WINS';
      }

           matches.push({
        teamAId: a.id,
        teamAName: a.name,
        teamBId: b.id,
        teamBName: b.name,
        scoreA,
        scoreB,
        winnerId,
        result,
        explanation: isSpecialMatch(a, b, scoreA, scoreB)
          ? `${a.name} scored ${scoreA}/100 and ${b.name} scored ${scoreB}/100. This is a special match because ${
              scoreA === scoreB
                ? 'the result is a draw.'
                : Math.abs(scoreA - scoreB) <= 3
                  ? 'the result was exceptionally close.'
                  : 'the winning team had a lower average character rating.'
            }`
          : ''
      });
    }
  }

  const evaluations = room.players.map(player => ({
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
  }));

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

async function evaluateTeamsWithGemini(model, teams) {
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

  const result = await generateWithRetry(model, prompt, 'Team evaluation');
  const parsed = extractJSON(result.response.text());

  if (!Array.isArray(parsed.teams) || parsed.teams.length !== teams.length) {
    throw new Error('Gemini did not evaluate every team.');
  }

  const validIds = new Set(teams.map(team => team.playerId));
  const seen = new Set();

  return parsed.teams.map(entry => {
    if (!validIds.has(entry.playerId) || seen.has(entry.playerId)) {
      throw new Error('Gemini returned an invalid or duplicate team evaluation.');
    }

    seen.add(entry.playerId);

    const score = Number(entry.score);
    if (!Number.isFinite(score)) throw new Error('Invalid team evaluation score.');

    return {
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
            characterName: safeText(item.characterName, 'Team member'),
            contribution: safeText(item.contribution, 'Not specified')
          }))
        : [],
      rankingRationale: safeText(entry.rankingRationale)
    };
  });
}

// --------------------------------------------------
// AI HEAD-TO-HEAD MATCHUPS IN BATCHES
// --------------------------------------------------

async function evaluateMatchupBatch(model, batch) {
  const prompt = `
You are a neutral judge comparing teams in a fictional and sporting team-building championship.

Evaluate every matchup in this batch.
Use only the supplied character information.
Do not invent powers, skills, achievements or weaknesses.
Consider team balance, role diversity, synergy and how each character contributes against the opposing team.
Include individual character contribution analysis for BOTH teams.
For fictional characters, keep the analysis non-graphic and focused on abilities and strategy.
For Football and Cricket, focus on sporting ability, roles and team balance.
Scores must be integers from 1 to 100.
A higher score wins. Equal scores mean a draw.
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

  const result = await generateWithRetry(model, prompt, 'Matchup batch');
  const parsed = extractJSON(result.response.text());

  if (!Array.isArray(parsed.matchups) || parsed.matchups.length !== batch.length) {
    throw new Error('Gemini returned an incomplete matchup batch.');
  }

  return parsed.matchups;
}

function sanitizeCharacterAnalysis(entries, team, opponentTeam) {
  const teamNames = new Set(team.map(character => character.name));
  const opponentNames = new Set(opponentTeam.map(character => character.name));

  if (!Array.isArray(entries)) {
    return buildCharacterAnalysis(team, opponentTeam);
  }

  const byName = new Map();

  for (const entry of entries) {
    if (!teamNames.has(entry.characterName)) continue;

    const opponentMatchups = Array.isArray(entry.opponentMatchups)
      ? entry.opponentMatchups
          .filter(item => opponentNames.has(item.opponentName))
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

// --------------------------------------------------
// COMPLETE GEMINI CHAMPIONSHIP
// --------------------------------------------------

async function evaluateChampionshipWithGemini(room) {
  const model = getGeminiModel();

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

  // First request: one overall evaluation for each team.
  const evaluations = await evaluateTeamsWithGemini(model, teams);
  const evaluationMap = new Map(
    evaluations.map(evaluation => [evaluation.playerId, evaluation])
  );

  // Prepare every unique pair of teams.
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

  // Five team matchups per request keeps responses more manageable.
  const batches = [];
  for (let i = 0; i < allPairs.length; i += 5) {
    batches.push(allPairs.slice(i, i + 5));
  }

  const allMatches = [];

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];

    const requestData = batch.map(pair => ({
      teamAId: pair.teamAId,
      teamBId: pair.teamBId,
      teamA: pair.teamA,
      teamB: pair.teamB
    }));

    const returned = await evaluateMatchupBatch(model, requestData);

    for (const entry of returned) {
      const pair = batch.find(p =>
        p.teamAId === entry.teamAId && p.teamBId === entry.teamBId
      );

      if (!pair) throw new Error('Gemini returned an unexpected matchup.');

      const scoreA = Number(entry.scoreA);
      const scoreB = Number(entry.scoreB);

      if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB)) {
        throw new Error('Gemini returned invalid matchup scores.');
      }

      const cleanScoreA = Math.max(1, Math.min(100, Math.round(scoreA)));
      const cleanScoreB = Math.max(1, Math.min(100, Math.round(scoreB)));

      let winnerId = null;
      let result = 'DRAW';

      if (cleanScoreA > cleanScoreB) {
        winnerId = pair.teamAId;
        result = 'TEAM_A_WINS';
      } else if (cleanScoreB > cleanScoreA) {
        winnerId = pair.teamBId;
        result = 'TEAM_B_WINS';
      }

      const playerA = findPlayer(room, pair.teamAId);
      const playerB = findPlayer(room, pair.teamBId);

      allMatches.push({
        teamAId: pair.teamAId,
        teamAName: playerA.name,
        teamBId: pair.teamBId,
        teamBName: playerB.name,
        scoreA: cleanScoreA,
        scoreB: cleanScoreB,
        winnerId,
        result,
                explanation: isSpecialMatch(
          playerA,
          playerB,
          cleanScoreA,
          cleanScoreB
        )
          ? safeText(
              entry.explanation,
              `${playerA.name}: ${cleanScoreA}/100. ${playerB.name}: ${cleanScoreB}/100.`
            )
          : '',
        analysisStatus: 'complete'
      });
    }

    console.log(
      `Gemini matchup batch ${batchIndex + 1}/${batches.length} completed`
    );
  }

  if (allMatches.length !== allPairs.length) {
    throw new Error('Gemini did not evaluate every head-to-head matchup.');
  }

  const standings = calculateStandings(room, allMatches, evaluations);

  return {
    matches: allMatches,
    standings,
    totalMatches: allMatches.length,
    completedAt: Date.now(),
    overallSummary:
      'Gemini evaluated every team and every head-to-head matchup, including individual character contributions.',
    rankingExplanation:
      'Final ranking combines 70% normalized head-to-head match points and 30% Gemini overall team evaluation.',
    aiEvaluation: {
      provider: 'Gemini',
      status: 'complete',
      message:
        `Gemini evaluated ${teams.length} teams and ${allMatches.length} head-to-head matchups in ${batches.length + 1} requests. Character contributions and opposing-character matchups were AI evaluated.`
    },
    rankingRules: [
      '70% of the final score comes from normalized head-to-head match points.',
      '30% of the final score comes from Gemini overall team evaluation.',
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

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'BATTLE AUCTION',
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY)
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

  // CREATE ROOM
  socket.on('room:create', ({ name, settings = {} } = {}) => {
    let code;
    do {
      code = roomCode();
    } while (rooms.has(code));

    const startingBudget = 100;

    const player = {
      id: socket.id,
      name: String(name || 'Host').trim().slice(0, 24),
      budget: startingBudget,
      team: [],
      connected: true
    };

    const room = {
      code,
      hostId: socket.id,
      status: 'lobby',
      settings: {
        startingBudget,
        teamSize: 3,
        turnSeconds: 10,
        startingBid: 1,
        universes: ['Marvel', 'DC'],
        ...settings
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
      stateVersion: 0
    };

    rooms.set(code, room);
    socket.join(code);
    socket.emit('room:created', publicRoom(room, socket.id));
    emitRoom(room);
  });

  // JOIN ROOM
  socket.on('room:join', ({ code, name } = {}) => {
    const room = rooms.get(String(code || '').toUpperCase());

    if (!room || room.status !== 'lobby') {
      return socket.emit('error:message', 'Room not found or game already started.');
    }

    if (room.players.length >= 10) {
      return socket.emit('error:message', 'Room is full.');
    }

    const player = {
      id: socket.id,
      name: String(name || 'Player').trim().slice(0, 24),
      budget: room.settings.startingBudget,
      team: [],
      connected: true
    };

    room.players.push(player);
    socket.join(room.code);
    socket.emit('room:joined', publicRoom(room, socket.id));
    emitRoom(room);
  });

  // START GAME
  socket.on('room:start', async ({
    universes,
    teamSize,
    turnSeconds,
    startingBid
  } = {}) => {
    const room = [...rooms.values()].find(r => r.hostId === socket.id);
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

      room.characters = shuffle(uniqueCharacters).slice(0, requiredCharacters);

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
    const room = [...rooms.values()].find(r => r.hostId === socket.id);
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
    const room = [...rooms.values()].find(r => r.hostId === socket.id);
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
    for (const room of rooms.values()) {
      const player = findPlayer(room, socket.id);
      if (!player) continue;

      player.connected = false;

      if (room.status === 'auction') {
        if (room.currentTurnPlayerId === socket.id) {
          stopTimer(room.code);
          room.passedPlayerIds.add(socket.id);
          room.noIncreaseTurns = room.passedPlayerIds.size;
          room.currentTurnPlayerId = socket.id;
          room.turnDeadline = null;
          finishTurnCycle(room);
        } else {
          if (room.highestBidderId === socket.id) {
            room.highestBidderId = null;
            room.lastBidderId = null;
            room.currentBid = room.settings.startingBid;
            room.passedPlayerIds = new Set();
          }

          emitRoom(room);
        }
      } else {
        emitRoom(room);
      }
    }
  });
});

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
// START SERVER
// --------------------------------------------------

server.listen(PORT, () => {
  console.log(`BATTLE AUCTION server listening on ${PORT}`);
});
