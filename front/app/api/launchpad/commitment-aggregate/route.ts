import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
const ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export async function POST(request: Request) {
  try {
    let body;
    try { body=await request.json(); } catch { return NextResponse.json({ok:false,error:"Invalid JSON"},{status:400}); }
    const sale=body?.sale_pubkey;
    if(typeof sale!=="string" || !ADDRESS.test(sale)) return NextResponse.json({ok:false,error:"Invalid sale address"},{status:400});
    const {data,error}=await getSupabaseAdmin().rpc("commitment_totals",{p_network:detectNetwork(),p_sale:sale});
    if(error || !data) return NextResponse.json({ok:false,error:"Totals temporarily unavailable"},{status:503});
    return NextResponse.json({ok:true,data});
  } catch { return NextResponse.json({ok:false,error:"Totals temporarily unavailable"},{status:503}); }
}
