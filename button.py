import pygame
from config import *

class Button():
    def __init__(self, text, pos):
        self.font = pygame.font.Font('freesansbold.ttf', 18)
        self.x, self.y = pos
        self.colour = LIGHT_GREY
        self.colour_pressed = DARK_GREY
        self.width = 80
        self.height = 40
        self.button = pygame.Rect(pos[0],pos[1],self.width,self.height)
        self.name = text
        self.text = self.font.render(text, True, BLACK, LIGHT_GREY)
        self.textRect = self.button
        self.textRect.center = (self.x + self.width//2, self.y + self.height//2)

    def execute(self):
        print(f"Executing {self.name}")

    def pos_in_button(self, pos):
        if self.x <= pos[0] <= self.x + self.width:
            if self.y <= pos[1] <= self.y + self.height:
                return True
        return False

    def draw_self(self, surface):   
        surface.blit(surface, self.button)     
        surface.blit(self.text, self.textRect)
        



    

    