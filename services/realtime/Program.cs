using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.IdentityModel.Tokens;

var builder = WebApplication.CreateBuilder(args);
var jwtSecret = builder.Configuration["JWT_SECRET"] ?? "xtract-local-dev-secret-change-me-32";
var broadcastSecret = builder.Configuration["REALTIME_BROADCAST_SECRET"] ?? "xtract-local-realtime-secret";
if (Encoding.UTF8.GetByteCount(jwtSecret) < 32)
{
    throw new InvalidOperationException("JWT_SECRET must be at least 32 bytes for HS256 authentication.");
}
var allowedOrigins = (builder.Configuration["WEB_ORIGIN"] ?? "http://localhost:5173,http://127.0.0.1:5173")
    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

builder.Services.AddCors(options => options.AddDefaultPolicy(policy => policy
    .WithOrigins(allowedOrigins)
    .AllowAnyHeader()
    .AllowAnyMethod()
    .AllowCredentials()));
builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.MapInboundClaims = false;
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = false,
            ValidateAudience = false,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtSecret)),
            NameClaimType = "username",
            RoleClaimType = "role",
            ClockSkew = TimeSpan.FromSeconds(30),
        };
        options.Events = new JwtBearerEvents
        {
            OnMessageReceived = context =>
            {
                var accessToken = context.Request.Query["access_token"];
                if (!string.IsNullOrEmpty(accessToken) &&
                    context.HttpContext.Request.Path.StartsWithSegments("/hubs/documents"))
                {
                    context.Token = accessToken;
                }
                return Task.CompletedTask;
            },
        };
    });
builder.Services.AddAuthorization();
builder.Services.AddSignalR();

var app = builder.Build();
app.UseCors();
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/health", () => Results.Ok(new { status = "ready" }));
app.MapHub<DocumentHub>("/hubs/documents");
app.MapPost("/internal/document-changed", async (
    HttpRequest request,
    DocumentChangedEvent documentEvent,
    IHubContext<DocumentHub> hub) =>
{
    if (!request.Headers.TryGetValue("X-Realtime-Secret", out var suppliedSecret) ||
        !string.Equals(suppliedSecret, broadcastSecret, StringComparison.Ordinal))
    {
        return Results.Unauthorized();
    }
    if (string.IsNullOrWhiteSpace(documentEvent.DocumentId) ||
        string.IsNullOrWhiteSpace(documentEvent.Status))
    {
        return Results.BadRequest(new { message = "documentId and status are required." });
    }
    await hub.Clients.All.SendAsync("documentChanged", documentEvent);
    return Results.Accepted();
});

app.Run();

[Authorize(Roles = "admin,validator")]
public sealed class DocumentHub : Hub;

public sealed record DocumentChangedEvent(
    string EventId,
    string DocumentId,
    long Revision,
    string Status,
    string[] ChangedFields,
    DateTimeOffset UpdatedAt);
