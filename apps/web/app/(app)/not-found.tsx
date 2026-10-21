import Link from "next/link";
import { EmptyState } from "../../components/ui";

export default function NotFound() {
  return <EmptyState text="This page does not exist." action={<Link href="/trade">Open the market page {"→"}</Link>} />;
}
