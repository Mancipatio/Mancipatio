import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const calls=vi.hoisted(()=>({platform:vi.fn(),admin:vi.fn(),network:vi.fn(async()=>{})}));
vi.mock("@/lib/server/rpc",()=>({getServerRpc:()=>({})}));
vi.mock("@/lib/network",()=>({detectNetwork:()=>"devnet"}));
vi.mock("@/lib/network-identity",()=>({createNetworkVerifier:()=>calls.network}));
vi.mock("@/lib/server/siws",()=>({SiwsError:class extends Error {constructor(public status:number,message:string){super(message);}}}));
vi.mock("@/lib/generated/asset_registry",()=>({ASSET_REGISTRY_PROGRAM_ADDRESS:"registry",fetchMaybePlatform:calls.platform,fetchMaybeAdmin:calls.admin,findAdminRecordPda:async()=>["admin"],findPlatformPda:async()=>["platform"]}));
import {requireAdmin,requireSuperAdmin} from "@/lib/server/admin-gate";
beforeEach(()=>{
  vi.clearAllMocks();calls.platform.mockResolvedValue({exists:true,programAddress:"registry",data:{admin:"super"}});
  calls.admin.mockResolvedValue({exists:true,programAddress:"registry",data:{admin:"operator"}});
});
describe("live finalized API authority",()=>{
  it("does not reuse positive authority after revocation",async()=>{
    await expect(requireAdmin("operator")).resolves.toBeUndefined();
    calls.admin.mockResolvedValue({exists:false});
    await expect(requireAdmin("operator")).rejects.toMatchObject({status:403});
    expect(calls.admin).toHaveBeenCalledTimes(2);
    expect(calls.admin.mock.calls[0][2]).toMatchObject({commitment:"finalized"});
  });
  it.each(["foreign-owner","wrong-wallet"])("rejects %s",async kind=>{
    calls.admin.mockResolvedValue({exists:true,programAddress:kind==="foreign-owner"?"foreign":"registry",data:{admin:kind==="wrong-wallet"?"other":"operator"}});
    await expect(requireAdmin("operator")).rejects.toMatchObject({status:403});
  });
  it("rotates super admin immediately after finalized state changes",async()=>{
    await expect(requireSuperAdmin("super")).resolves.toBeUndefined();
    calls.platform.mockResolvedValue({exists:true,programAddress:"registry",data:{admin:"new-super"}});
    await expect(requireSuperAdmin("super")).rejects.toMatchObject({status:403});
    await expect(requireSuperAdmin("new-super")).resolves.toBeUndefined();
  });
});
