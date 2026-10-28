import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { openBot } from "../src/index";

const nonHumanText = `Creation of a reliable, scalable replacement for the Lead Forensics external API

Introduction

The existing external Lead Forensics API (documented at https://leadforensics-api.readme.io/docs/getting-started) has suffered from a longstanding lack of reliability, scalability, and operability and now has incompatibilities with the new Business Lists capability which has just been released.

As a result, we have reached the point where we need to redevelop the API on a more modern and manageable foundation (addressing issues in the existing system would likely take longer and have a poorer outcome).

Initially, it was intended that, in order to facilitate a migration, the new API endpoints created on the new system will be strictly compatible with the previous ones, with the possible exception of a new, more modern authentication mechanism. However, as the project has proceeded, the decision has been taken to initially build the API around modern standards rather than aim for strict compatibility, whilst still retaining as much of the old API structure as possible. If this proves to be a significant barrier to customer migration, we will look to add compatibility later at a later stage.

This redevelopment will happen in a number of phases. 

Phase 1: Initial customer

Work with a single significant user of the API (Impartner, who is experiencing ongoing issues with the existing API) as a co-creator and deliver to them the four endpoints they currently use in the new system
https://interact.leadforensics.com/WebApi_v2/Visit/GetVisitDetails
https://interact.leadforensics.com/WebApi_v2/Business/GetBusiness
https://interact.leadforensics.com/WebApi_v2/Page/GetPagesByVisit
https://interact.leadforensics.com/WebApi_v2/Visit/GetAllVisits

In this phase, we should also add two further endpoints, used by our telemarketing partner, Paragon, to pull visits from customer portals in order to reach out to them
https://interact.leadforensics.com/WebApi_v2/Business/GetAllBusinesses
https://interact.leadforensics.com/WebApi_v2/Visit/GetVisitsByTriggerReport
https://interact.leadforensics.com/WebApi_v2/Reference/GetTriggerReportList

GetTriggerReportList is required to retrieve the appropriate trigger report/filter id to pass into GetVisitsByTriggerReport

In addition, the GetVisit endpoint will be available as its functionality aligns with GetVisitDetails and GetAllVisits
https://interact.leadforensics.com/WebApi_v2/Visit/GetVisit

Phase 2a: Incremental functionality for Impartner

Impartner’s use of the API is based around conversions (Key Pages) and their use of LF would be considerably streamlined if they were able to add these through the API. In addition, this would also remove a significant burden from the LF CSM who currently creates these manually in the portal. 

The requirement for this is to 

add an equivalent for GetConversionList to provide a way to get conversion IDs

add an equivalent to the existing GetVisitsByConversion endpoint to the new API

add a new endpoint to create a new Conversion / Key Page in the LF system.
We are currently in the process of renaming Conversions as Key Pages and so the new endpoint should reflect the latter
the new endpoint should mimic the actions possible from the portal setup page at:
https://portal.leadforensics.com/ConversionTracking with the exception of the “Select Score Type” drop down which does not need to be considered.

Phase 2b: Support for Contacts acquisition in the in-CRM widget

The in-CRM widget is a new addition to our Salesforce capabilities which will allow Salesforce users significantly better access to LF data in their CRM and, crucially, will allow customers to obtain LF contacts without having to leave the Salesforce environment.

The new API will need to provide the endpoints required to allow users to obtain contacts through the widget, see:

 IN CRM - Problem and Success - INITIATIVES - Confluence
https://leadforensics.atlassian.net/wiki/spaces/PMT/pages/1328349209 

Product contact for in-CRM: @Mel Tidy 

At least initially these contact endpoints will be hidden and so not directly available to customers in the API. 

Phase 3a: Self-service access to clientID and Secrets

Customers will need secure access to their API credentials (ClientID and Secret) which should be provided through the page in the LF portal at:
Integration API Details

Note that the ClientID for the API is different from the existing LF ClientID, examples are:

LF ClientID: 265339

API ClientID: yBM3M7hm3ueRT1jq3TUxmdiJxekHKU16

Phase 3b: SingleStore connectivity

Once the SingleStore project is at a suitable point the new API will need to be migrated from the current dummy dataset to the live data in the new data platform

Phase 4a: Undocumented endpoint for retrieving Google Cookie GUID

A couple of years ago we added an private / undocumented API endpoint parameter for Infineon to retrieve a Google GUID from a cookie. The GUID is injected into the tracking code by the customer. The IPFlow setup is below along with details of the customized call/

Infineon are no longer a customer but we have two new customers who want to make use of this (Omnia Partners and LexusNexus), these two are in the late stages of the sales process and likely to become customers soon so it would be good to make this call available to them so we can put them straight onto API2.

getPages API Endpoint Update

A new parameter has been added to the getPages API endpoint.

New Parameter: displayCookie

The new parameter is displayCookie, and it can take the value true or false.

Example API Call

For example, the following call:

https://interact.leadforensics.com/WebApi_v2/Page/getpages?pagesize=10&pageno=1&datefrom=2024-05-15&dateto=2024-05-17&displayCookie=true

will return the same data as the original getPages endpoint but with the new “Cookie” property added to the results in this format:

{
    "PageVisitList": [
        {
            "Cookie": "IFXbccffedeb83a32xxxxxxxxxxxxxxxxxxxx:1553022857.1715918316",
            "BusinessID": 666967,
            "VisitID": 12380477526,
            "PageVisitDateTime": "2024-05-16T23:59:45",
            "PageLocation": https://www.infineon.com/cms/en/product/power/mosfet/silicon-carbide/modules/ff8mr12w1m1h_b11/,
            "PageTitle": "FF8MR12W1M1H_B11 - Infineon Technologies",
            "ReferringSite": https://www.bing.com/
        },
        ...
    ]
}



IPFlow setup

Infineon are pushing a custom value to us using the trk_cookie variable in their tracking script. The data is store for 14 days in the dbo.VisitPageDetails table.

You can view a sample of the data using:

SELECT DISTINCT TOP (10) V.VisitID, BI.[Name], BI.Website, PD.Cookie

FROM dbo.Visit V

INNER JOIN dbo.BusinessInformation BI ON BI.BusinessID = V.BusinessID

INNER JOIN dbo.VisitPageDetails PD ON PD.VisitID = V.VisitID AND PD.ClientID = V.ClientID

WHERE V.ClientID = 782224

AND V.StartDateTime > DATEADD(DD, -1, GETDATE())

AND PD.Cookie IS NOT NULL

AND PD.Cookie != ''



Phase 4b: Business List Customer End Points

One of the key issues with the existing API is that it is incompatible with Business Lists. Specifically the following endpoints will fail to take account of Categories, Assignments and Business Statuses set by Business Lists.

Business/GetBusinessesByCategory

Business/GetBusinessesByAssignedTo

Visit/GetVisitsByTriggerReport

For this reason 65 (as of 22-June-26) of our existing API customers have been held on Data Manager until we can get them onto API2 which will resolve the issues with the calls above (or their equivalents in the new system)

In order to get these 62 customers onto API2 we also need to make available equivalents of those calls they are currently using which have not been implemented in the first 3 phases of this project.

As endpoint usage is not evenly spread we can get more customers able to migrate sooner by batching the most used ones first.

Batch 1 (covers 53 of 65 customers) use the following 12 endpoints of which 7 are already covered by previous phases

Business/GetAllBusinesses

Already done

Business/GetBusiness

Already done

Business/GetBusinessesByAssignedTo



Business/GetBusinessesByCategory



Page/GetPages



Page/GetPagesByVisit

Already done

Reference/GetCategoryList



Reference/GetConversionList

Already done

Reference/GetTriggerReportList

Already done

Visit/GetAllVisits

Already done

Visit/GetVisitsByBusiness



Visit/GetVisitsByTriggerReport

Already done

Batch 2 (takes us to 59 of 65 customers) use the following 12 endpoints of which 1 (possibly 2) is already covered by previous phases

KPI/employeeband



KPI/MostPopularPages



KPI/newleads



Visit/Get10MostRecent

could be done by limiting main visits call to 10

Visit/GetVisitDetails

Already done

kpi/visits



KPI/MostActiveCompanies



Batch 3 (the rest)

KPI/Industries



KPI/PageViews



KPI/VisitByHour



Reference/GetAssignedToList



Visit/GetVisitsByConversion

Already done

KPI/Counties



KPI/Countries



KPI/Devices



KPI/Keywords



KPI/Languages



KPI/LatestVisits



KPI/LeadFunnel



KPI/OperatingSystem



KPI/ReferringSites



KPI/States



KPI/TopExitPages



KPI/TopLandingPages



KPI/WatchList



Reference/GetClientPortalLogins



Visit/GetVisit

Already done

Phase 4c: Incremental expansion to cover all existing API use

After phase 4b, none of the remaining documented endpoints have been called by customers in the last 8 weeks and so we should not port them across.  

Reference/GetEmployeeBandList

Reference/GetIndustryList

Reference/GetCountryList

Reference/GetCountyList

Reference/GetDateList

In addition there are a number of admin calls in the old API only some of which have been called in the last week and all calls have come from the LF 1392 API Key. These warrant extra investigation before we port them to see if they are really needed.

Admin/SetSubscriptions

Called

Admin/GetSubscriptionList

Called

Admin/GetSubscription

Called

Admin/Get20MostRecentCalls

Not called

Admin/GenerateAPIKey

Not called

Admin/SetAPIKey

Called

Admin/SetApiThreshold

Called

Admin/DeleteClient

Called

Admin/Activate

Not called

Admin/Deactivate

Not called

Admin/DecodeAPIKey

Not called

Admin/TopUserCalls

Called

Admin/NoCallsMade

Called

Admin/NoCallsIn5Days

Not called

Admin/WhitelistClients

Called

Admin/ExpiredKeys

Called

Admin/InactiveClients

Called

Admin/ExceededThresholds

Called

Admin/LiveThresholds

Called

Admin



Not called

Phase 5: Internal API Monitoring and Support tools

Phase 5a: bring the rate limiting infrastructure to production standard and prepare it for connection the the new P&P work being undertaken by @Jean-Michel Gaud 

Phase 5b: provide a mechanism to disable a customer’s access to the API and prepare if for connection the new P&P work being undertaken by @Jean-Michel Gaud.  

Phase 5c: Add monitoring to the API to cover two uses :

Provide the RUN ability to:

proactively monitor the system for issues

debug and investigate issues as they arise  

Provide a replacement for integrations.ClientAPICall in the existing API which allows the product team to understand customers usage of the API through ad-hoc queries. Investigation underway to establish is this can be achieved by the existing Loggly capabilities

Phase 5d: Documentation

Harden the documentation

Add a link to it from the API page in the portal

Make the rate limits more visible in the documetation

Phase 5e: Remove the conflict between the Zapier visits endpoint and a call to the new API without an API version, allowing the return of a suitable error message if someone call an endpoint without an API version. 

Phase 5f: Make the following changes for completness and consistency

Add Business Status, Categories and Assignees to the payload returned for a business

Add endoints to:

assign a category to a business

remove a category from a business

assign a business status to a business (there is no concept of deleting a BS, all you can do is reset it to "No Status")

assign a business to a user

unassing a business from a user

list business statuses in the system

list users in the system



  

Value Description

Although usage of the external API is limited to a small number of customers (approx. 186 active), there are a significant number of high-value clients using it, for example:

Reed Exhibitions - £84k

Impartner - £25k (with the possibility of expanded usage if the API is stable)

Additionally, an API is a standard feature expected of a SaaS platform and without one there will be occasions in the future where we will lose deals.

 Summary



The problem statement being explored

The current API is unreliable, hard to operate, and is incompatible with Business Lists but remains key to a number of customers including one of our largest customers. We are looking to replace it with a new API which remedies these issues.



The business value it offers to customers

A stable and scalable API will allow a number of large customers to more confidently use the capability and in some cases expand their use.

The value to LF (GRR, NRR, GTM, …)

GRR - there is a significant risk to our API customers due to lack of reliability.

NRR - we have customers (e.g. Impartner) who are reluctant to expand their usage of the product due to the fragility of the API, but if the API were reliable there is definite possibility this would change.

GTM - there are occasions when API access to our data is a key requirement for prospects 

 Problem Statement

What problems are being solved? Include context, user pain points, or supporting data.

Problem Being Addressed:

Pain Points Resolved

Supporting Info

The current API is unreliable

Customers get intermittent 500 errors when calling the API. 



The current API is hard to operate

Diagnosing the cause of the errors is practically impossible 



The current API is not scalable

Rate limits need to be conservatively set in order to protect the infrastructure



 

















 Constraints

Describe any constraints on this problem space, times, costs etc

Constraint

Details

SingleStore dependency

The data for the new API will need to come from the new SingleStore data platform and so will not be able to be rolled out until this is available for customers.

 Success Criteria

What are the high-level success criteria for the project? Which idea will actually address the underlying problem the best? What questions need to be asked to answer this?
>Include key metrics for success

Success Criteria:

How It Will Be Measured:

Migration from the old API to the new one will be straightforward for customers. 

Customer feedback

API errors will be eliminated (or very significantly reduced)

Logging in the API infrastructure and feedback from co-creator customers

The new API infrastructure will be straightforward to operate

Errors which arise can be quickly diagnosed and fixed by the Run team

 Risks

What risks can cause us to not achieve our success criteria or the value being realizable? Do we need any POCs to mitigate these risks?

 Sign-offs

Version of this page Signed off: add link to this page with the specific version that was signed off.

Department

Approver

Date Sign-Off Given

Product

Donald



Engineering

Ed



Customer Success

N/A



SLT

Ed`;

const homedir = "/home/nixos/pi-extensions/bot/examples/humanizer";

const bot = await openBot(homedir, {
  model: "xai/grok-4.7",
  agentDir: getAgentDir(),
  thinking: "high",
});

try {
  const result = await bot.run(
    "Review your own BOT.md instructions and optimise them for your specialization.",
    {
      onEvent: (event) => console.log(event.type),
    },
  );
  console.log(result.output, result.sessionId, result.usage);
} catch (err) {
  console.error(`Error: ${err}`);
} finally {
  await bot.close();
}
