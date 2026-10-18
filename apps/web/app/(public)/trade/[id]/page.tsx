import { PublicMarket } from "../../../../components/public/PublicMarket";

export default async function TradeMarketPage({ params }: { params: Promise<{ id: string }> }) {
  return <PublicMarket id={(await params).id} />;
}
