export type HairStyle = "short" | "bun" | "long" | "cap" | "curly" | "bald" | "bob" | "udeng" | "afro";

export type Look = {
  skin: string;
  hair: string;
  hairStyle: HairStyle;
  shirt: string;
  pants: string;
  shoes: string;
  headphones?: string;
  glasses?: boolean;
};

export type Pose = "stand" | "walk" | "type" | "read" | "think" | "hand" | "coffee" | "chat" | "cheer" | "sleep" | "slump" | "watch";
