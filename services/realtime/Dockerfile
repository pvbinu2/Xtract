FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src
COPY services/realtime/Xtract.Realtime.csproj services/realtime/
COPY services/realtime/ services/realtime/
RUN dotnet publish services/realtime/Xtract.Realtime.csproj -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:9.0
WORKDIR /app
COPY --from=build /app/publish .
ENV ASPNETCORE_URLS=http://0.0.0.0:5080
EXPOSE 5080
ENTRYPOINT ["dotnet", "Xtract.Realtime.dll"]
