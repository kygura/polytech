"use client";
import { createContext, useContext } from "react";

/** The status bar's left slot on workspace pages: /trade portals its key legend and feed badge here (DESIGN 13.3). null until the bar mounts. */
export const StatusSlotContext = createContext<HTMLElement | null>(null);
export const useStatusSlot = () => useContext(StatusSlotContext);
