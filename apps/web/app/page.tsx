import { redirect } from "next/navigation";

// Home = the terminal: market list (falls back to top markets before the first screen run), book, chart, ticket.
export default function Home() {
  redirect("/trade");
}
