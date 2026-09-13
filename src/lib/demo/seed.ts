import type { Store } from "@/lib/store/types";

// Sample data for demo mode. Each step writes one kind of data through the Store, so a
// later phase adds its demo rows by appending a step to SEED_STEPS.

export interface SeedContext {
  store: Store;
  // The time the seeding started. Steps place their rows relative to it.
  now: Date;
  // Sets the time the store stamps on the rows written next. null returns to real time.
  travelTo(date: Date | null): void;
}

export type SeedStep = (context: SeedContext) => Promise<void>;

export interface DemoVideoSeed {
  title: string;
  script: string;
  monitoring: boolean;
  daysAgo: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function paragraphs(...parts: string[]): string {
  return parts.join("\n\n");
}

export const DEMO_VIDEOS: readonly DemoVideoSeed[] = [
  {
    title: "Why Your Home WiFi Is Slow and How to Fix It",
    monitoring: true,
    daysAgo: 12,
    script: paragraphs(
      "Your internet plan says three hundred megabits, but the video call in your kitchen still freezes every few minutes. Before you blame your provider, let me show you what is actually going on inside your house, because in most homes the problem is not the connection coming in. It is everything that happens after the signal leaves the router.",
      "Start with where the router lives. Most of them get installed wherever the cable enters the building, which usually means a closet, a basement corner, or behind the television. Radio waves hate all three. Concrete, mirrors, fish tanks and even a full bookshelf soak up the signal. If you can move the router to a central spot, up off the floor and out in the open, you will often gain more speed than any upgrade could give you.",
      "Next, look at the channel. Your router shares the air with every network on your street. In an apartment building I tested last month, twenty two networks were fighting over the same three channels. Open your router settings, run the channel scan, and pick the least crowded option. If your router supports the five gigahertz or six gigahertz bands, put your laptop and television there and leave the older band for smart plugs and the doorbell.",
      "Now the part nobody wants to hear. That router your provider gave you six years ago might simply be too old. Older hardware cannot handle thirty devices at once, and every phone, speaker and light bulb in your home is asking for attention. If you have more than one floor, a mesh system with two or three small units will cover the house far better than one powerful box in the corner.",
      "Finally, test properly. Run a speed test next to the router, then in the room where things go wrong. If the numbers are fine near the router and terrible in the bedroom, the fix is coverage, not a faster plan. If both are slow, call your provider with those results in hand.",
      "Try these steps tonight, and tell me in the comments how much faster your connection got. Next week we are building a home network rack on a tiny budget, so subscribe so you do not miss it.",
    ),
  },
  {
    title: "Cast Iron Cooking for Beginners",
    monitoring: false,
    daysAgo: 5,
    script: paragraphs(
      "Three years ago I bought a cast iron skillet at a flea market for five dollars. It was rusty, sticky and honestly a little scary. Today it is the pan I reach for every single morning, and I want to show you exactly how I brought it back and how I cook with it without any of the stress people warn you about.",
      "First, the rust. If your pan looks like mine did, scrub it with steel wool and warm soapy water until you see bare grey metal. Yes, soap is fine. The old rule about never using soap comes from a time when soap contained lye. Dry the pan completely on the stove over low heat, because even a few drops of water will bring the rust right back.",
      "Seasoning is just oil that has been baked into a hard layer. Rub a very thin coat of any neutral oil over every surface, then wipe it off as if you made a mistake. The pan should look almost dry. Bake it upside down at two hundred and fifty degrees Celsius for an hour and let it cool in the oven. Repeat that three times and you have a finish that will last for years.",
      "Now let us cook. The biggest mistake beginners make is putting food into a cold pan. Cast iron heats slowly and holds that heat for a long time, so give it five full minutes on medium before anything touches it. Flick a drop of water in. When it dances across the surface, you are ready. Today I am searing a steak, and notice I am not moving it at all. It will release on its own once the crust forms.",
      "Afterwards, clean it while it is still warm. A brush and hot water handle almost everything. For stuck bits, pour in coarse salt and scrub with a paper towel. Dry it on the burner, add a few drops of oil, and put it away.",
      "That is really all there is to it. Cast iron is not delicate, it just likes a little routine. In the next video I am baking cornbread in this same skillet, so hit subscribe and I will see you in the kitchen.",
    ),
  },
  {
    title: "Two Days Hiking the West Highland Way",
    monitoring: false,
    daysAgo: 2,
    script: paragraphs(
      "We had exactly two days, one tent and a weather forecast that changed its mind every hour. This is the story of our first overnight hike on the West Highland Way in Scotland, including the part where I almost gave up at the top of the Devil's Staircase.",
      "We started early on Saturday at Bridge of Orchy with packs that were far too heavy. My advice before anything else is to lay out everything you plan to carry and remove a third of it. We brought three different jackets and a full cooking set for what turned out to be two simple meals. Every extra item turned into a small argument with gravity on the first climb.",
      "The first stretch across Rannoch Moor is one of the emptiest landscapes I have ever walked through. There are no trees, no buildings and almost no sound except the wind and the crunch of the old military road under your boots. It is beautiful, but it is also exposed, so if the clouds drop, you want a map and a compass and you want to know how to use them. Your phone battery will not last as long as you hope in the cold.",
      "We camped near Kingshouse that night. Wild camping is legal in most of Scotland, but it comes with responsibilities. Pitch late, leave early, stay away from the road and take every piece of rubbish home with you. The midges found us within minutes, so a head net is not optional between June and September.",
      "Day two brought the Devil's Staircase, a zigzag path that climbs steeply out of Glen Coe. It sounds dramatic, and my legs agreed, but it only takes about an hour at a steady pace. The view from the top across the mountains made every heavy step worth it. From there it is a long, gentle descent into Kinlochleven, where we celebrated with the largest plate of chips I have ever seen.",
      "If you are planning your own trip, I have put our full gear list and route notes in the description. Next time we are tackling the whole route over seven days, so subscribe and come along with us.",
    ),
  },
];

const seedVideos: SeedStep = async ({ store, now, travelTo }) => {
  for (const video of DEMO_VIDEOS) {
    travelTo(new Date(now.getTime() - video.daysAgo * DAY_MS));
    await store.createVideo({ title: video.title, script: video.script, monitoring: video.monitoring });
  }
};

export const SEED_STEPS: readonly SeedStep[] = [seedVideos];

export async function seedDemoData(context: SeedContext): Promise<void> {
  try {
    for (const step of SEED_STEPS) {
      await step(context);
    }
  } finally {
    context.travelTo(null);
  }
}
