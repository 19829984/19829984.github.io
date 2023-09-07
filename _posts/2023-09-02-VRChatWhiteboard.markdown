---
layout: post
title:  "[Unity/VRChat] Creating a synced whiteboard in VRChat"
date:   2023-09-02 08:50:00 -0500
categories: Tech_Art
---

<p align="center">
    <img src="/assets/vr_whiteboard/demo.gif">
    <h5 align="center"><i> Demo of the whiteboard working between two networked players</i></h5>
</p>

## Table of Contents
- [Table of Contents](#table-of-contents)
- [Preface](#preface)
  - [How VRChat Players Usually Draw](#how-vrchat-players-usually-draw)
- [Requirements](#requirements)
- [SDF (Signed Distance Field)](#sdf-signed-distance-field)
  - [Limitations of SDFs](#limitations-of-sdfs)
- [Network Sync and Serialization](#network-sync-and-serialization)
  - [Polyline](#polyline)
- [Whiteboard Rendering Pipeline](#whiteboard-rendering-pipeline)
  - [1. Rendering Polylines](#1-rendering-polylines)
  - [2. Blit to Whiteboard Render Texture](#2-blit-to-whiteboard-render-texture)
  - [3. Rendering The Whiteboard SDF](#3-rendering-the-whiteboard-sdf)
- [Marker Whiteboard System](#marker-whiteboard-system)
  - [Marker Script](#marker-script)
  - [Whiteboard Script](#whiteboard-script)
- [Limitations and Future Works](#limitations-and-future-works)
- [Code](#code)
  - [`Marker.cs`](#markercs)
  - [`WhiteBoard.cs`](#whiteboardcs)
  - [`CustomWhiteboardBlit.shader`](#customwhiteboardblitshader)
  - [`Whiteboard.shader`](#whiteboardshader)


## Preface
I was replicating a room from my college for use in VRChat, and it has some whiteboards. Naturally, we'd want to be able to draw on them. However, this room has 8 sliding whiteboards and 4 static whiteboards, a total of 12. This presented some technical challenges that took me a while to figure out, so I'd like to document my implementation here.

### How VRChat Players Usually Draw
VRChat provides sample prefabs that includes a pen for players to draw in 3D space. It's implemented by drawing ribbons along 3D points the pen samples. However, this is not a good fit for whiteboards primarily because the number of ribbons must be limited, since they are unique GameObjects and can easily clutter the scene and reduce performance. We don't want people's pen strokes to start disappearing from the whiteboards as they put down more marks. Further, to replicate the feel of drawing on a whiteboard, we want strokes to be erasable and merge together when overlapped. Therefore, we must go with a texture solution. 

<p align="center">
    <img src="/assets/vr_whiteboard/3d_pen_example.png">
    <h5 align="center"><i> Ribbons being drawn in 3D space</i></h5>
</p>

## Requirements
These whiteboards, besides being able to be drawn to and erased from, must:
-   Have high image fidelity(smooth strokes)
-   Share one texture to save resources
-   Sync across the network

## SDF (Signed Distance Field)
*For more info about SDFs, read about them [**here**](https://iquilezles.org/articles/raymarchingdf/):*

The first and second requirement seems to contradict each other. Since the whiteboards will be viewed from up close and far away, to preserve stroke quality we'd need to allocate a large amount of pixels per board. However, to share that texture across 12 different boards means that it must be an extremely large texture, which is simply unfeasible; especially for a VR application. 

Taking inspiration from Valve's [**excellent paper**](https://cdn.akamai.steamstatic.com/apps/valve/2007/SIGGRAPH2007_AlphaTestedMagnification.pdf) on rendering high quality glyphs with ***Signed Distance Fields(SDFs)***, we can do the same. As seen from Valve's **Figure 1** example, they can render high quality images with small 8 bit textures. Thus, we can combine the SDF textures for every whiteboard onto a single smaller texture that won't eat up all of our precious VRAM. 

### Limitations of SDFs
SDFs work of off single channel data, meaning that the source texture no longer represents color in RGBA, but instead represents 4 different SDFs, barring us from representing all colors. I think this tradeoff is well worth it, given the amount of resources we save with the SDF technique, as well as the high definition images we get out of it. 

## Network Sync and Serialization
Making the whiteboard work properly in multiplayer is rather tricky. We cannot directly serialize and deserialize textures over network in VRChat, since our bandwidth is **extremely limited**.

From [VRChat documentation](https://creators.vrchat.com/worlds/udon/networking/network-details/):

>Continuous sync is limited to roughly **200 bytes** per serialization.
>
>Manual sync is limited to roughly **49 Kilobytes** per serialization.
>
>Each manually-synced object is rate limited as a factor of the data size. The more it sends, the more its send rate is limited. You can call RequestSerialization as many times as you want, but it will wait until enough time has passed before calling OnPreSerialization, sending the data, and calling OnPostSerialization with the result.
>
>A single synced string can have roughly 126 characters in Continuous sync mode.
>
>You can send out about **11kb per second**.

At first, the marker would directly draw onto the client's local render textures every frame while it's in contact. However, that wouldn't affect any other player's texture. So, I tried to simply sync the transforms of a marker as often as I can, hoping that each client's result would be close enough, but that wasn't the case at all. 
<p align="center">
    <img src="/assets/vr_whiteboard/shit-network-1.png" width="50%"><img src="/assets/vr_whiteboard/shit-network-2.png" width="50%">
    <h5 align="center"><i>Two clients in the same world having wildly different results</i></h5>
</p>

### Polyline
So instead, at the suggestion of my friend [HeadMerchant](https://github.com/HeadMerchant), I changed the implementation to sample the marker's position and record polylines, then draw each polyline onto the whiteboard when it reaches a certain length or stops. 

Before a new polyline is drawn, we record the current one and serialize its  data over the network. We use `Vector4[]` to store our polyline (`xyz` for position, `w` for color), so the amount of data we send over the network is negligible with short polylines. A `Vector4` has 4 `floats`, each `float` is `4 bytes`, therefore with each polyline we send `<Polyline Length> * 16` bytes of data. 

Since we're manually syncing, we are well below our `49 kilobyte` per serialization bandwidth as long as we don't make each polyline too long. Theoretically, we can have `49*1024/16=3136` points per polyline before we reach the manual sync limit. 

## Whiteboard Rendering Pipeline
With the rendering technique and our data structure established, now we can define a rather simple rendering pipeline:
1. [Draw a polyline stroke onto a render texture as a SDF](#1-rendering-polylines)
2. [Blit the render texture to one of the 4 channels in the whiteboard render texture, or subtract from all channels if erasing.](#2-blit-to-whiteboard-render-texture)
3. [Render the SDF texture with a custom shader on a whiteboard object](#3-rendering-the-whiteboard-sdf)

While my friend HeadMerchant suggested using Custom Render Textures' double buffering feature to combine both the stroke render texture and the whiteboard render texture into a single asset, unfortunately due to limitations in UdonSharp's API, Custom Render Textures are unavailable to us; nor are command buffers. Therefore, we must manually create both render textures assets and call `VRCGraphics.Blit()` manually to render them. 

For a prototype, I decided to only implement 8 of the 12 whiteboards using two `1086x1020` textures. I chose this resolution because each tile would be `543x255` with an aspect ratio of `2.413`, which matches the aspect ratio of my whiteboard model. This is important so that our texture is not distorted on an axis when it's used on the whiteboard asset. 

The stroke render texture is configured to only contain a single 8-bit unsigned channel without filtering, while the whiteboard texture is configured to contain 4 8-bit unsigned channels with bilinear filtering.

All shaders in this section will have their full source code available at the bottom of the page. 

### 1. Rendering Polylines
To render polylines into marker strokes, we'd need the SDF function of a polyline. There is no closed form function for a polyline SDF, so we must calculate a cylinder sdf for each two consecutive points then combine them to generate our polyline SDF. From Inigo's list of SDF functions, the function for a capsule/line between two points in 3D space is:
```glsl
float sdCapsule( vec3 p, vec3 a, vec3 b, float r )
{
    vec3 pa = p - a, ba = b - a;
    float h = clamp( dot(pa,ba)/dot(ba,ba), 0.0, 1.0 );
    return length( pa - ba*h ) - r;
}
```
However, we must modify this to account for the texture's aspect ratio. I've also changed it such that it converts the sdf into a mask of a line without negative values. 
```hlsl
float sdCapsule(float2 p, float2 a, float2 b, float r)
{
    float2 pa = p - a, ba = b - a;
    pa.x *= _AspectRatio;
    ba.x *= _AspectRatio;
    float h = clamp( dot(pa,ba)/dot(ba,ba), 0.0, 1.0 );
    return  max((-length( pa - ba*h ) + r)/r, 0);
}
```
For the prototype, I've limited each polyline to have a max of `20` points. In shaderlab, we can only statically define the size of arrays, so we will allocate an array of 20 `float4` to pass our `Vector4[]` into. Then, we'd also need to pass in the actual size of our polyline, since it could terminate before filling up all 20 points. Finally, we pass in the aspect ratio, as well as a scale and offset to sample the correct whiteboard tile's uv.
```hlsl
float4 _Polyline_Pos[20];
float _Polyline_Len;
float _AspectRatio;
float4 _ScaleOffset;
```
Then, we write a fragment shader to render our stroke.
```hlsl
fixed4 frag (v2f i) : SV_Target
{
    // Draw Line
    float2 uv = (i.uv * _ScaleOffset.xy) - _ScaleOffset.zw;
    // Discard fragments outside of the 0-1 uv range
    if (any(uv > 1 || uv < 0)){
        discard;
    }
    // Calculate sdf
    float val = sdCapsule(uv, float2(_Polyline_Pos[0].xy), float2(_Polyline_Pos[1].xy), _Polyline_Pos[0].z);
    for (int index = 1; index < _Polyline_Len; index++){
        float new_val = sdCapsule(uv, float2(_Polyline_Pos[index-1].xy), float2(_Polyline_Pos[index].xy), _Polyline_Pos[index-1].z);
        val = max(val, new_val);
    }
    fixed4 col = 0;
    col.rgb = val;

    col.a = 1;
    return col;
}
```
Finally, we render it with some UdonSharp calls
```csharp
private void RenderPolyline(){
    // _AspectRatio and is set during initialization of the script 
    whiteboardBlitMaterial.SetVectorArray("_Polyline_Pos", last_polyline);
    whiteboardBlitMaterial.SetFloat("_Polyline_Len", last_polyline_index);
    whiteboardBlitMaterial.SetVector("_ScaleOffset", scaleOffset);
    VRCGraphics.Blit(markerDrawRT, markerDrawRT, whiteboardBlitMaterial, whiteboardBlitMaterial.FindPass("Draw"));
    ...
}
```

For organizational purposes, I will place this shader in a pass called `Draw` in a shader named `CustomWhiteboardBlit.shader`.

\* Note that here we're not using the fourth element of our `float4` array. That's the color channel of the stroke, which will be used later in the whiteboard shader. However, we still pass in the `float4` array directly to avoid rebuilding a new `float3` array just to save a little bit of memory and compute time. 

<p align="center">
    <img src="/assets/vr_whiteboard/marker_rt_example.png">
    <h5 align="center"><i> Strokes being rendered onto each whiteboard tile</i></h5>
</p>

### 2. Blit to Whiteboard Render Texture
Now we must write two more shaders to add our strokes to the whiteboard texture's appropriate channel, or subtract from the whiteboard texture.

For a draw operation, we prepare a pass called `Add` configured to perform a max operation between the stroke texture and the whiteboard. Then in the fragment shader, we adjust for tiling with `_ScaleOffset`, then discard fragments outside of the 0-1 uv range, and finally multiply our texture sample with 
```hlsl
Pass
{
    Name "Add"

    Blend One One
    BlendOp Max

    CGPROGRAM
...
    sampler2D _MainTex;
    float4 _MainTex_ST;
    fixed4 _Channel;
    float4 _ScaleOffset;
...
    fixed4 frag (v2f i) : SV_Target
    {
        float2 uv = (i.uv * _ScaleOffset.xy) - _ScaleOffset.zw;
        // Discard fragments outside of the 0-1 uv range
        if (any(uv > 1 || uv < 0)){
            discard;
        }
        // sample the texture with original uv because both
        // are already in grid format
        float val = tex2D(_MainTex, i.uv).r;
        // apply fog
        UNITY_APPLY_FOG(i.fogCoord, col);
        return val * _Channel;
    }
    ENDCG
}
```

Then, for erasing, we write a similar shader but with `RevSub` operation, which subtracts the source texture from the destination (subtracts our stroke from the whiteboard). We don't need a a `_Chanel` parameter because a eraser would erase all colors.
```hlsl
Pass
{
    Name "Sub"

    Blend One One
    BlendOp RevSub

    CGPROGRAM
...
    sampler2D _MainTex;
    float4 _MainTex_ST;
    float4 _ScaleOffset;
...
    fixed4 frag (v2f i) : SV_Target
    {
        float2 uv = (i.uv * _ScaleOffset.xy) - _ScaleOffset.zw;
        // Discard fragments outside of the 0-1 uv range
        if (any(uv > 1 || uv < 0)){
            discard;
        }
        // sample the texture with original uv because both
        // are already in grid format
        fixed4 col = tex2D(_MainTex, i.uv).r;
        // apply fog
        UNITY_APPLY_FOG(i.fogCoord, col);
        return col;
    }
    ENDCG
}
```

I've placed these two shaders with the `Draw` pass inside `CustomWhiteboardBlit.shader`.

Then in UdonSharp, we render to the whiteboard with the following lines of code:
```csharp
private void RenderPolyline(){
    ...
    whiteboardBlitMaterial.SetColor("_Channel", ConvertMarkerChannel((int)last_polyline[0][3]));
    if (current_polyline_is_erase)
    {
        VRCGraphics.Blit(markerDrawRT, whiteboardRT, whiteboardBlitMaterial, whiteboardBlitMaterial.FindPass("Sub"));
    }
    else
    {
        VRCGraphics.Blit(markerDrawRT, whiteboardRT, whiteboardBlitMaterial, whiteboardBlitMaterial.FindPass("Add"));
    }
}
```
### 3. Rendering The Whiteboard SDF
Finally, to render our SDF into a whiteboard, we write a Unity surface shader:
```hlsl
...
half _Glossiness;
half _Metallic;
fixed4 _Color1;
fixed4 _Color2;
fixed4 _Color3;
float _MarkerThreshold;
float4 _ScaleOffset;
float _Smoothness;
...
void surf (Input IN, inout SurfaceOutputStandard o)
{
    _Smoothness = min(_Smoothness, _MarkerThreshold);
    // Albedo comes from a texture tinted by color
    float2 uv = (IN.uv_MainTex + _ScaleOffset.zw) / _ScaleOffset.xy;
    fixed4 texSample = tex2D(_MainTex, uv);
    texSample -= _MarkerThreshold;
    // Anti-alias method with smoothstep mentioned by Valve in the same paper
    texSample = smoothstep(-_Smoothness, _Smoothness, texSample);

    fixed4 c1 = (texSample.r) * _Color1;
    fixed4 c2 = (texSample.g) * _Color2;
    fixed4 c3 = (texSample.b) * _Color3;
    float c4 = (texSample.a);
    fixed4 c = c1 + c2 + c3;
    float3 out_col = lerp(1, c.rgb, c.a) - c4;
    
    // Add smooth step to make the edges of the marker more smooth
    o.Albedo = out_col;
    // Metallic and smoothness come from slider variables
    o.Metallic = _Metallic;
    o.Smoothness = _Glossiness;
    o.Alpha = 1;
}
```

In the end, our whiteboard texture will look something like this
<p align="center">
    <img src="/assets/vr_whiteboard/whiteboard_rt_example.png">
    <h5 align="center"><i> Each tile corresponds to a whiteboard </i></h5>
</p>

 
<p align="center">
    <img src="/assets/vr_whiteboard/whiteboard_example.png">
    <h5 align="center"><i> Each whiteboard properly display their own tile </i></h5>
</p>

## Marker Whiteboard System
Here I want to briefly go over how I've written the marker script and whiteboard scripts to interact with each other. I will include their full source code at the bottom of the page, here's an incomplete outline of our classes
```csharp
public class Marker : UdonSharpBehaviour
{
    Whiteboard GetWhiteboardFromRay(RaycastHit raycast_res);
    private void StopDrawing();
    private void GetNearestWhiteboardRaycastIndex(RaycastHit[] raycast_results, out int raycast_index, out bool valid);
    void FixedUpdate();
}
```

```csharp
public class Whiteboard : UdonSharpBehaviour
{
    public override void OnPostSerialization(SerializationResult result);
    public override void OnDeserialization();
    public void SetWhiteboardOwner(VRCPlayerApi newOwner);
    public void AddPolylinePoint(Vector2 point, float size, bool is_erase, int channel, bool continue_last_line);
    public void EndLine(bool continue_last_line);
    private void RecordPolyine();
    private void ClearPolyline(bool continue_last_line);
    private void RenderPolyline();
}
```
### Marker Script
In `Marker.cs`'s `FixedUpdate`, when a player picks up a marker and tries to use it, we check the following things in order:
1. Whether the marker has moved by a minimum distance since the last update
2. Raycast from the marker for a short distance
3. Check if the nearest hit object is valid, has a `Whiteboard` UdonSharpBehaviour script, and is within a certain distance

If all three conditions are true, then we:
1. Set the whiteboard object's owner to the marker object's owner
2. Sample the UV of the raycast hit point, and call the whiteboard's `AddPolylinePoint(...)` function. 

If **either** condition `2` or `3` fails, then we end the line that we're drawing with `StopDrawing()`, if there is one. `StopDrawing()` calls the `Whiteboard` script's `Endline` function with `continue_last_line=false` to prevent a new line being connected to the previous one. 

Finally, we record the position of the marker tip for the next update. 

### Whiteboard Script
In `AddPolylinePoint(...)`, we do the following:
- **If** the current polyline has reached its maximum length, terminate it with `EndLine(...)` and pass in `continue_last_line`
  - `Endline(...)` does the following:
    1. Record the current polyline into a temporary polyline
    2. Clear the current polyline, insert the last point from the recorded polyline if `continue_last_line=true`
    3. Set `renderingPolyline=true` and request Serialization of polyline data
- **Else** add the new point into the current polyline
  - If we're inserting into an empty polyline, then we insert the same point twice so that if that is the only point drawn, a circle will be correctly drawn with our rendering pipeline. 

We only render the polyline with `RenderPolyLine()` if either:
- In `OnPostSerialization` event we see that the serialization is successful and `renderingPolyline=true`
  - This is triggered on the host client after serialization is requested
- In `OnDeSerialization` event we see `renderingPolyline=true`
  - This is triggered on all other players' clients after they've received the serialized polyline data. 

There are many other details that I must gloss over, you can read them for yourself at the bottom of the page.

## Limitations and Future Works
One limitation is that if a player joins later, then they will not see any things that were drawn on the whiteboard before they've joined. This is because none of the strokes are recorded, and we do not sync the texture upon a player joining. 

We could solve this by either:
1. Figuring out a way to sync the texture on join
2. Store all or recent strokes somewhere and reconstruct them for the new player upon initialization.

Further, currently we do not support two people drawing on the same whiteboard. We could implement a simple queue system of polylines instead of holding only one active polyline at a time to resolve this. 

## Code
### `Marker.cs`
```csharp

using UdonSharp;
using UnityEngine;
using VRC.SDKBase;
using VRC.Udon;

public enum MarkerChannel : int
{
    RED,
    GREEN,
    BLUE,
    BLACK
}

public class Marker : UdonSharpBehaviour
{
    public float minMoveDistance = 0.005f;
    public Transform rayStart;
    public Transform rayEnd;
    public float tipRadius = 0.1f;
    public float minDistanceToKeepDraw = 0.1f;
    public Transform penTip;

    public MarkerChannel markerChannel;

    public bool erase = false;

    private bool isDrawing;
    private bool isUsing;
    private Vector3 currentPos;
    private Vector3 lastPos;
    private Vector2 hitUV;
    private float rayDist;
    private Whiteboard whiteboard;
    private const int WHITEBOARD_LAYER = 31;
    public override bool OnOwnershipRequest(VRCPlayerApi requester, VRCPlayerApi newOwner)
    {
        return true;
    }

    void Start()
    {
        currentPos = penTip.position;
        lastPos = penTip.position;
        rayDist = (rayEnd.position - rayStart.position).magnitude;
    }
    Whiteboard GetWhiteboardFromRay(RaycastHit raycast_res)
    {
        if (raycast_res.collider != null && raycast_res.collider.gameObject != null)
        {
            return raycast_res.collider.gameObject.GetComponent<Whiteboard>();
        }
        return null;
    }

    public override void OnDrop()
    {
        StopDrawing();
    }

    private void StopDrawing()
    {
        if (isDrawing && whiteboard != null)
        {
            whiteboard.EndLine(continue_last_line: false);
            whiteboard = null;
        }
    }

    private void GetNearestWhiteboardRaycastIndex(RaycastHit[] raycast_results, out int raycast_index, out bool valid)
    {
        float nearest_dist = Mathf.Infinity;
        int nearest_raycast_index = -1;
        raycast_index = -1;
        valid = false;

        for (int i = 0; i < raycast_results.Length; i++)
        {
            RaycastHit rh = raycast_results[i];
            if (rh.collider.gameObject.layer == WHITEBOARD_LAYER && rh.distance < nearest_dist)
            {
                nearest_dist = rh.distance;
                nearest_raycast_index = i;
            }
        }
        if (nearest_raycast_index == -1)
        {
            valid = false;
        }
        else
        {
            valid = true;
            raycast_index = nearest_raycast_index;
        }
    }

    public override void OnPickupUseDown(){
        isUsing = true;
    }

    public override void OnPickupUseUp(){
        isUsing = false;
        StopDrawing();
    }

    void FixedUpdate()
    {
        if (!isUsing)
        {
            return;
        }

        currentPos = penTip.position;
        if (Vector3.Distance(currentPos, lastPos) > minMoveDistance)
        {
            RaycastHit[] raycast_res = Physics.RaycastAll(rayStart.position, penTip.up, rayDist + 1);
            // Find nearest raycast result with whiteboard
            GetNearestWhiteboardRaycastIndex(raycast_res, out int rh_index, out bool is_rh_valid);
            if (is_rh_valid)
            {
                RaycastHit nearest_raycast = raycast_res[rh_index];
                Whiteboard wb = GetWhiteboardFromRay(nearest_raycast);
                if (wb)
                {
                    whiteboard = wb;
                    if (nearest_raycast.distance < rayDist)
                    {
                        // Make the drawer owner of the whiteboard so that its variables are synced from them. 
                        VRCPlayerApi this_owner = Networking.GetOwner(this.gameObject);
                        if (Networking.GetOwner(whiteboard.gameObject) != this_owner || Networking.GetOwner(wb.whiteboardFrame.gameObject) != this_owner)
                        {
                            wb.SetWhiteboardOwner(this_owner);
                        }

                        hitUV = nearest_raycast.textureCoord;

                        if (Networking.GetOwner(whiteboard.gameObject) != this_owner || Networking.GetOwner(wb.whiteboardFrame.gameObject) != this_owner)
                        {
                            // Debug.LogError("Player does not own whiteboard and frame, not drawing");
                            return;
                        }

                        wb.AddPolylinePoint(hitUV, tipRadius, erase, (int)markerChannel, isDrawing);
                        lastPos = penTip.position;
                        isDrawing = true;
                        return;
                    }
                }
            }
            // No whiteboard hit within drawing range, end the line.
            StopDrawing();
            isDrawing = false;
        }

        lastPos = penTip.position;
    }
}
```

### `WhiteBoard.cs`
```csharp

using UdonSharp;
using UnityEngine;
using System.Collections.Generic;
using UnityEngine.Rendering;
using VRC.SDKBase;
using VRC.Udon;
using VRC.Udon.Common;

// Note for future: I think it may be ok for multiple whiteboards to be blitting to the same render texture without needing a queue system?
// Since they're all blitting to different parts of the render texture, we can use Blend One One Max op, and make each board clear its own area
// Before it blits to it via a -1 subtraction. 
[UdonBehaviourSyncMode(BehaviourSyncMode.Manual)]
public class Whiteboard : UdonSharpBehaviour
{
    public Material whiteboardBlitMaterial;
    [SerializeField]
    public limit_board_location whiteboardFrame;

    [SerializeField]
    private RenderTexture whiteboardRT;
    private float ASPECT_RATIO = 2.4130489912f; // Aspect ratio of the whiteboard object

    [SerializeField]
    private RenderTexture markerDrawRT;
    public Vector2 whiteboardGridSize = new Vector2(1, 1);
    public Vector2 whiteboardGridIndex = new Vector2(0, 0);
    // Don't forget to update the shader array too when you change this
    // If this value is too low, RequestSerialization gets called too often
    // and lines get lost. 
    private const int POLYLINE_MAX_LEN = 20;

    // Recorded Polyline for rendering
    // Polyline structure: {uv.x, uv.y, size, channel}
    [UdonSynced]
    private Vector4[] last_polyline = new Vector4[POLYLINE_MAX_LEN];
    [UdonSynced]
    private int last_polyline_index = 0;
    private bool last_polyline_is_erase = false;

    // Current working polyline
    private Vector4[] current_polyline = new Vector4[POLYLINE_MAX_LEN];
    private int current_polyline_index = 0;
    private bool current_polyline_is_erase = false;

    // State variables
    [UdonSynced]
    private bool isDrawing = false;
    [UdonSynced]
    private bool renderingPolyline = false;
    private Vector4 scaleOffset;
    void Start()
    {
        whiteboardBlitMaterial.SetFloat("_AspectRatio", ASPECT_RATIO);

        // Set main texture for all materials through shared material
        GetComponent<Renderer>().sharedMaterials[0].mainTexture = whiteboardRT;
        scaleOffset = new Vector4(whiteboardGridSize.x, whiteboardGridSize.y, whiteboardGridIndex.x, whiteboardGridIndex.y);
        // Set scale and offset for each instance
        GetComponent<Renderer>().materials[0].SetVector("_ScaleOffset", scaleOffset);
    }

    public bool GetIsDrawing()
    {
        return isDrawing;
    }

    public override bool OnOwnershipRequest(VRCPlayerApi requestingPlayer, VRCPlayerApi requestedOwner)
    {
        // Decline ownership transfer if we're in the middle of drawing
        return !isDrawing;
    }

    public override void OnPostSerialization(SerializationResult result)
    {
        if (result.success)
        {
            if (renderingPolyline)
            {
                // Render polyline only if data is successfully serialized
                RenderPolyline();
            }
        }
        else
        {
            // Request serialization on fail
            RequestSerialization();
        }
    }

    public override void OnDeserialization()
    {
        if (renderingPolyline)
        {
            // Other client's whiteboard should render polyline after serialization synced variables. 
            RenderPolyline();
        }
    }

    public void SetWhiteboardOwner(VRCPlayerApi newOwner)
    {
        Networking.SetOwner(newOwner, this.gameObject);
        Networking.SetOwner(newOwner, whiteboardFrame.gameObject);
        RequestSerialization();
    }

    public void AddPolylinePoint(Vector2 point, float size, bool is_erase, int channel, bool continue_last_line)
    {
        isDrawing = true;
        if (current_polyline_index == POLYLINE_MAX_LEN)
        {
            EndLine(continue_last_line);
        }
        else
        {
            current_polyline.SetValue(new Vector4(point.x, point.y, size, channel), current_polyline_index);
            // Insert two of the same point for first point wihtout incrementing index twice 
            // so that if that is the only point, we draw only a circle with linedraw
            if (current_polyline_index == 0)
            {
                current_polyline.SetValue(new Vector4(point.x, point.y, size, channel), current_polyline_index + 1);
            }
            current_polyline_index += 1;
            current_polyline_is_erase = is_erase;
        }
    }

    public void EndLine(bool continue_last_line)
    {
        // Record our polyline
        RecordPolyine();
        // Start a new one
        ClearPolyline(continue_last_line);
        renderingPolyline = true;
        // Sync variable
        RequestSerialization();
        // RenderPolyline(); // Comment this out when running actual game
    }

    private void RecordPolyine()
    {
        current_polyline.CopyTo(last_polyline, 0);
        last_polyline_index = current_polyline_index;
        last_polyline_is_erase = current_polyline_is_erase;
    }

    private Color ConvertMarkerChannel(int channel)
    {
        /** For our whiteboard shader, we're using each channel of the texture
        for a separate color. Currently, it's red, blue, green, and black,
        respectively. 
        **/
        switch (channel)
        {
            case 0:
                return new Color(1, 0, 0, 0);
            case 1:
                return new Color(0, 1, 0, 0);
            case 2:
                return new Color(0, 0, 1, 0);
            case 3:
                return new Color(0, 0, 0, 1);
            default:
                return new Color(0, 0, 0, 0);
        }
    }

    private void ClearPolyline(bool continue_last_line)
    {
        if (continue_last_line)
        {
            Vector4 last_point = current_polyline[current_polyline_index - 1];
            current_polyline = new Vector4[POLYLINE_MAX_LEN];
            // Insert two of the same point for first point wihtout incrementing index twice 
            // so that if that is the only point, we draw only a circle with linedraw
            current_polyline.SetValue(last_point, 0);
            current_polyline.SetValue(last_point, 1);
            current_polyline_index = 1;

            continue_last_line = false;
        }
        else
        {
            isDrawing = false;
            current_polyline = new Vector4[POLYLINE_MAX_LEN];
            current_polyline_index = 0;
        }
    }

    private void RenderPolyline()
    {
        renderingPolyline = false;
        whiteboardBlitMaterial.SetVectorArray("_Polyline_Pos", last_polyline);
        whiteboardBlitMaterial.SetFloat("_Polyline_Len", last_polyline_index);
        whiteboardBlitMaterial.SetVector("_ScaleOffset", scaleOffset);
        VRCGraphics.Blit(markerDrawRT, markerDrawRT, whiteboardBlitMaterial, whiteboardBlitMaterial.FindPass("Draw"));

        whiteboardBlitMaterial.SetColor("_Channel", ConvertMarkerChannel((int)last_polyline[0][3]));
        if (current_polyline_is_erase)
        {
            VRCGraphics.Blit(markerDrawRT, whiteboardRT, whiteboardBlitMaterial, whiteboardBlitMaterial.FindPass("Sub"));
        }
        else
        {
            VRCGraphics.Blit(markerDrawRT, whiteboardRT, whiteboardBlitMaterial, whiteboardBlitMaterial.FindPass("Add"));
        }
    }
}
```

### `CustomWhiteboardBlit.shader`
```hlsl
Shader "Unlit/CustomWhiteboardBlit"
{
    Properties
    {
        _MainTex ("Texture", 2D) = "white" {}
        _Channel ("Channel", Color) = (1,0,0,0)

        _AspectRatio ("Aspect Ratio", Float) = 1
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" }
        LOD 100

        Pass
        {
            Name "Add"

            Blend One One
            BlendOp Max

            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            // make fog work
            #pragma multi_compile_fog

            #include "UnityCG.cginc"

            struct appdata
            {
                float4 vertex : POSITION;
                float2 uv : TEXCOORD0;
            };

            struct v2f
            {
                float2 uv : TEXCOORD0;
                UNITY_FOG_COORDS(1)
                float4 vertex : SV_POSITION;
            };

            sampler2D _MainTex;
            float4 _MainTex_ST;
            fixed4 _Channel;
            float4 _ScaleOffset;

            v2f vert (appdata v)
            {
                v2f o;
                o.vertex = UnityObjectToClipPos(v.vertex);
                o.uv = TRANSFORM_TEX(v.uv, _MainTex);
                UNITY_TRANSFER_FOG(o,o.vertex);
                return o;
            }

            fixed4 frag (v2f i) : SV_Target
            {
                float2 uv = (i.uv * _ScaleOffset.xy) - _ScaleOffset.zw;
                // Discard fragments outside of the 0-1 uv range
                if (any(uv > 1 || uv < 0)){
                    discard;
                }
                // sample the texture with original uv because both
                // are already in grid format
                float val = tex2D(_MainTex, i.uv).r;
                // apply fog
                UNITY_APPLY_FOG(i.fogCoord, col);
                return val * _Channel;
            }
            ENDCG
        }

        Pass
        {
            Name "Sub"

            Blend One One
            BlendOp RevSub

            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            // make fog work
            #pragma multi_compile_fog

            #include "UnityCG.cginc"

            struct appdata
            {
                float4 vertex : POSITION;
                float2 uv : TEXCOORD0;
            };

            struct v2f
            {
                float2 uv : TEXCOORD0;
                UNITY_FOG_COORDS(1)
                float4 vertex : SV_POSITION;
            };

            sampler2D _MainTex;
            float4 _MainTex_ST;
            float4 _ScaleOffset;

            v2f vert (appdata v)
            {
                v2f o;
                o.vertex = UnityObjectToClipPos(v.vertex);
                o.uv = TRANSFORM_TEX(v.uv, _MainTex);
                UNITY_TRANSFER_FOG(o,o.vertex);
                return o;
            }

            fixed4 frag (v2f i) : SV_Target
            {
                float2 uv = (i.uv * _ScaleOffset.xy) - _ScaleOffset.zw;
                // Discard fragments outside of the 0-1 uv range
                if (any(uv > 1 || uv < 0)){
                    discard;
                }
                // sample the texture with original uv because both
                // are already in grid format
                fixed4 col = tex2D(_MainTex, i.uv).r;
                // apply fog
                UNITY_APPLY_FOG(i.fogCoord, col);
                return col;
            }
            ENDCG
        }
        
        Pass
        {
            Name "Draw"

            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            // make fog work
            #pragma multi_compile_fog

            #include "UnityCG.cginc"

            struct appdata
            {
                float4 vertex : POSITION;
                float2 uv : TEXCOORD0;
            };

            struct v2f
            {
                float2 uv : TEXCOORD0;
                UNITY_FOG_COORDS(1)
                float4 vertex : SV_POSITION;
            };


            // Polyline structure: {uv.x, uv.y, size, is_erase}
            float4 _Polyline_Pos[20];
            float _Polyline_Len;
            float _AspectRatio;
            float4 _ScaleOffset;
            
            v2f vert (appdata v)
            {
                v2f o;
                o.vertex = UnityObjectToClipPos(v.vertex);
                o.uv = v.uv;
                UNITY_TRANSFER_FOG(o,o.vertex);
                return o;
            }

            // From https://iquilezles.org/articles/distfunctions/
            // Modified to return the mask of a line without negative values
            float sdCapsule(float2 p, float2 a, float2 b, float r)
            {
                float2 pa = p - a, ba = b - a;
                pa.x *= _AspectRatio;
                ba.x *= _AspectRatio;
                float h = clamp( dot(pa,ba)/dot(ba,ba), 0.0, 1.0 );
                return  max((-length( pa - ba*h ) + r)/r, 0);
            }

            fixed4 frag (v2f i) : SV_Target
            {
                // Draw Line
                float2 uv = (i.uv * _ScaleOffset.xy) - _ScaleOffset.zw;
                // Discard fragments outside of the 0-1 uv range
                if (any(uv > 1 || uv < 0)){
                    discard;
                }
                // Calculate sdf
                float val = sdCapsule(uv, float2(_Polyline_Pos[0].xy), float2(_Polyline_Pos[1].xy), _Polyline_Pos[0].z);
                for (int index = 1; index < _Polyline_Len; index++){
                    float new_val = sdCapsule(uv, float2(_Polyline_Pos[index-1].xy), float2(_Polyline_Pos[index].xy), _Polyline_Pos[index-1].z);
                    val = max(val, new_val);
                }
                fixed4 col = 0;
                col.rgb = val;

                col.a = 1;
                return col;
            }
            ENDCG
        }
    }
}
```

### `Whiteboard.shader`
```hlsl
Shader "Custom/WhiteBoard"
{
    Properties
    {
        _Color1 ("Marker 1 Color", Color) = (1,0,0,1)
        _Color2 ("Marker 2 Color", Color) = (0,1,0,1)
        _Color3 ("Marker 3 Color", Color) = (0,0,1,1)
        _MainTex ("Albedo (RGB)", 2D) = "white" {}
        _Glossiness ("Smoothness", Range(0,1)) = 0.5
        _Metallic ("Metallic", Range(0,1)) = 0.0
        _MarkerThreshold ("Marker Threshold", Range(0, 1)) = 0.0
        _ScaleOffset ("Scale Offset", Vector) = (1,1,0,0)
        _Smoothness ("Smoothness(< Marker Threshold)", Range(0, 1)) = 0.0
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" }
        LOD 200

        CGPROGRAM
        // Physically based Standard lighting model, and enable shadows on all light types
        #pragma surface surf Standard fullforwardshadows

        // Use shader model 3.0 target, to get nicer looking lighting
        #pragma target 3.0

        sampler2D _MainTex;

        struct Input
        {
            float2 uv_MainTex;
        };

        half _Glossiness;
        half _Metallic;
        fixed4 _Color1;
        fixed4 _Color2;
        fixed4 _Color3;
        float _MarkerThreshold;
        float4 _ScaleOffset;
        float _Smoothness;

        // Add instancing support for this shader. You need to check 'Enable Instancing' on materials that use the shader.
        // See https://docs.unity3d.com/Manual/GPUInstancing.html for more information about instancing.
        // #pragma instancing_options assumeuniformscaling
        UNITY_INSTANCING_BUFFER_START(Props)
            // put more per-instance properties here
        UNITY_INSTANCING_BUFFER_END(Props)

        void surf (Input IN, inout SurfaceOutputStandard o)
        {
            _Smoothness = min(_Smoothness, _MarkerThreshold);
            // Albedo comes from a texture tinted by color
            float2 uv = (IN.uv_MainTex + _ScaleOffset.zw) / _ScaleOffset.xy;
            fixed4 texSample = tex2D(_MainTex, uv);
            texSample -= _MarkerThreshold;
            texSample = smoothstep(-_Smoothness, _Smoothness, texSample);

            fixed4 c1 = (texSample.r) * _Color1;
            fixed4 c2 = (texSample.g) * _Color2;
            fixed4 c3 = (texSample.b) * _Color3;
            float c4 = (texSample.a);
            fixed4 c = c1 + c2 + c3;
            float3 out_col = lerp(1, c.rgb, c.a) - c4;
            
            // Add smooth step to make the edges of the marker more smooth
            o.Albedo = texSample.rgb;
            // Metallic and smoothness come from slider variables
            o.Metallic = _Metallic;
            o.Smoothness = _Glossiness;
            o.Alpha = 1;
        }
        ENDCG
    }
    FallBack "Diffuse"
}
```
