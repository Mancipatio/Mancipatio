import { NextResponse } from "next/server";
import { address } from "@solana/kit";
import { siwsErrorResponse,SiwsError } from "@/lib/server/siws";
import { publishedSaleDocument } from "@/lib/server/sale-document";
export async function GET(request:Request) {
  try {
    const sale=new URL(request.url).searchParams.get("sale") ?? "";
    try {address(sale);} catch {throw new SiwsError(400,"Valid sale address required");}
    return NextResponse.json({ok:true,data:await publishedSaleDocument(sale)},{headers:{"Cache-Control":"no-store"}});
  } catch(error) {return siwsErrorResponse(error);}
}
