import { notFound } from "next/navigation";
import { isMarketId } from "../../../../components/terminal/marketList";

// The market page lives in the trade layout (it reads the id with useParams); this only turns a non-market id (`/trade/autonomy`) into a real 404.
export default async function TradeMarketPage({ params }: { params: Promise<{ id: string }> }) {
  if (!isMarketId((await params).id)) notFound();
  return null;
}
